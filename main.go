package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"code.nkcmr.net/sigcancel"
	"github.com/davecgh/go-spew/spew"
	"github.com/hashicorp/go-retryablehttp"
	"github.com/pkg/errors"
	"github.com/robfig/cron/v3"
)

type config struct {
	purpleAirSensorID, backupSensorID string
	iftttWHKey                        string
	twilioSid, twilioKey              string
	twilioFrom                        string
	smsRecipients                     string
}

func getEnvConfig() config {
	var cfg config
	cfg.purpleAirSensorID = os.Getenv("PURPLE_AIR_SENSOR_ID")
	cfg.backupSensorID = os.Getenv("BACKUP_PURPLE_AIR_SENSOR_ID")
	cfg.iftttWHKey = os.Getenv("IFTTT_WH_KEY")
	cfg.twilioSid = os.Getenv("TWILIO_ACCT_SID")
	cfg.twilioKey = os.Getenv("TWILIO_KEY")
	cfg.twilioFrom = os.Getenv("TWILIO_FROM_NUMBER")
	cfg.smsRecipients = os.Getenv("SMS_RECIPIENTS")
	return cfg
}

func initNotifier(cfg config, rc *retryablehttp.Client) (notifier, error) {
	var n notifier
	if cfg.iftttWHKey != "" {
		n = &iftttNotifier{
			rc:  rc,
			key: cfg.iftttWHKey,
		}
	} else if cfg.twilioSid != "" && cfg.twilioKey != "" && cfg.smsRecipients != "" && cfg.twilioFrom != "" {
		n = &smsNotifier{
			rc:         rc,
			tfrom:      cfg.twilioFrom,
			tacctsid:   cfg.twilioSid,
			tauthtoken: cfg.twilioKey,
			recipients: strings.Split(cfg.smsRecipients, ","),
		}
	} else {
		return nil, errors.New("improper notification configuration")
	}
	return n, nil
}

func _main() error {
	ctx, cancel := context.WithCancel(context.Background())
	go sigcancel.CancelOnSignal(cancel)

	cfg := getEnvConfig()
	fs := flag.NewFlagSet("aqimon", flag.ContinueOnError)
	fs.StringVar(&cfg.purpleAirSensorID, "sensor_id", cfg.purpleAirSensorID, "ID of the purple air sensor to watch")
	fs.StringVar(&cfg.backupSensorID, "backup_sensor_id", cfg.backupSensorID, "ID of the purple air sensor to use as a backup")
	fs.StringVar(&cfg.iftttWHKey, "ifttt_wh_key", cfg.iftttWHKey, "Key for ifttt webhook")
	fs.StringVar(&cfg.twilioSid, "twilio_acct_sid", cfg.twilioSid, "Twilio Account SID for sending SMS messages")
	fs.StringVar(&cfg.twilioKey, "twilio_key", cfg.twilioKey, "Twilio Account Auth Token for sending SMS messages")
	fs.StringVar(&cfg.twilioFrom, "twilio_from", cfg.twilioFrom, "Twilio phone number to send SMS messages from")
	fs.StringVar(&cfg.smsRecipients, "sms_recipients", cfg.smsRecipients, "Comma-delimited list of numbers to send SMS messages to")
	if err := fs.Parse(os.Args); err != nil {
		return errors.Wrap(err, "failed to parse cli flags")
	}
	rc := retryablehttp.NewClient()
	rc.HTTPClient.Timeout = time.Second * 5

	if cfg.purpleAirSensorID == "" {
		return errors.New("empty purpleair sensor id")
	}

	n, err := initNotifier(cfg, rc)
	if err != nil {
		return errors.Wrap(err, "failed to init notifier")
	}

	s := new(state)
	s.justStarted = true

	_ = checkAirQuality(ctx, cfg, s, rc, n)

	c := cron.New()
	_, _ = c.AddFunc("* * * * *", func() {
		if err := checkAirQuality(ctx, cfg, s, rc, n); err != nil {
			log.Printf("error: failed to check air quality: %s", err.Error())
			return
		}
		go deadManSnitch(ctx, rc)
	})
	c.Start()
	<-ctx.Done()
	<-c.Stop().Done()
	log.Printf("bye-bye!")
	return nil
}

type purpleAirResponse struct {
	MapVersion       string    `json:"mapVersion"`
	BaseVersion      string    `json:"baseVersion"`
	MapVersionString string    `json:"mapVersionString"`
	Results          []Results `json:"results"`
}
type Results struct {
	ID                           int     `json:"ID"`
	Label                        string  `json:"Label"`
	DEVICELOCATIONTYPE           string  `json:"DEVICE_LOCATIONTYPE,omitempty"`
	THINGSPEAKPRIMARYID          string  `json:"THINGSPEAK_PRIMARY_ID"`
	THINGSPEAKPRIMARYIDREADKEY   string  `json:"THINGSPEAK_PRIMARY_ID_READ_KEY"`
	THINGSPEAKSECONDARYID        string  `json:"THINGSPEAK_SECONDARY_ID"`
	THINGSPEAKSECONDARYIDREADKEY string  `json:"THINGSPEAK_SECONDARY_ID_READ_KEY"`
	Lat                          float64 `json:"Lat"`
	Lon                          float64 `json:"Lon"`
	PM25Value                    string  `json:"PM2_5Value"`
	LastSeen                     int64   `json:"LastSeen"`
	Type                         string  `json:"Type,omitempty"`
	Hidden                       string  `json:"Hidden"`
	DEVICEBRIGHTNESS             string  `json:"DEVICE_BRIGHTNESS,omitempty"`
	DEVICEHARDWAREDISCOVERED     string  `json:"DEVICE_HARDWAREDISCOVERED,omitempty"`
	DEVICEFIRMWAREVERSION        string  `json:"DEVICE_FIRMWAREVERSION,omitempty"`
	Version                      string  `json:"Version,omitempty"`
	LastUpdateCheck              int64   `json:"LastUpdateCheck,omitempty"`
	Created                      int     `json:"Created"`
	Uptime                       string  `json:"Uptime,omitempty"`
	RSSI                         string  `json:"RSSI,omitempty"`
	Adc                          string  `json:"Adc,omitempty"`
	P03Um                        string  `json:"p_0_3_um"`
	P05Um                        string  `json:"p_0_5_um"`
	P10Um                        string  `json:"p_1_0_um"`
	P25Um                        string  `json:"p_2_5_um"`
	P50Um                        string  `json:"p_5_0_um"`
	P100Um                       string  `json:"p_10_0_um"`
	Pm10Cf1                      string  `json:"pm1_0_cf_1"`
	Pm25Cf1                      string  `json:"pm2_5_cf_1"`
	Pm100Cf1                     string  `json:"pm10_0_cf_1"`
	Pm10Atm                      string  `json:"pm1_0_atm"`
	Pm25Atm                      string  `json:"pm2_5_atm"`
	Pm100Atm                     string  `json:"pm10_0_atm"`
	IsOwner                      int     `json:"isOwner"`
	Humidity                     string  `json:"humidity,omitempty"`
	TempF                        string  `json:"temp_f,omitempty"`
	Pressure                     string  `json:"pressure,omitempty"`
	AGE                          int     `json:"AGE"`
	Stats                        string  `json:"Stats"`
	ParentID                     int     `json:"ParentID,omitempty"`
}

type sensorData struct {
	V                 float64 `json:"v"`  // Real time or current PM2.5 Value
	V1                float64 `json:"v1"` // Short term (10 minute average)
	V2                float64 `json:"v2"` // 30 minute average
	V3                float64 `json:"v3"` // 1 hour average
	V4                float64 `json:"v4"` // 6 hour average
	V5                float64 `json:"v5"` // 24 hour average
	V6                float64 `json:"v6"` // One week average
	Pm                float64 `json:"pm"` // Real time or current PM2.5 Value
	LastModified      int64   `json:"lastModified"`
	TimeSinceModified int64   `json:"timeSinceModified"`
}

func deadManSnitch(ctx context.Context, rc *retryablehttp.Client) {
	snitch := os.Getenv("DEADMAN_SNITCH")
	if snitch == "" {
		return
	}
	_, _ = rc.Get(snitch)
}

func getPurpleAirSensorData(ctx context.Context, rc *retryablehttp.Client, cfg config, sensorID string) (rt, tenmavg float64, err error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second*30)
	defer cancel()
	req, _ := retryablehttp.NewRequest("GET", fmt.Sprintf("https://www.purpleair.com/json?show=%s", sensorID), nil)
	req = req.WithContext(ctx)
	req.Header.Set("User-Agent", "github.com/nkcmr/aqimon")
	resp, err := rc.Do(req)
	if err != nil {
		return 0, 0, errors.Wrap(err, "failed to send purple air data request")
	}
	defer resp.Body.Close()
	respData, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return 0, 0, errors.Wrap(err, "failed to read purple air response")
	}
	if resp.StatusCode == http.StatusOK {
		var data purpleAirResponse
		if err := json.Unmarshal(respData, &data); err != nil {
			return 0, 0, errors.Wrap(err, "failed to json decode purple air response")
		}
		if len(data.Results) == 0 {
			if cfg.backupSensorID != "" && sensorID != cfg.backupSensorID {
				log.Printf("warning: zero results returned for primary sensor, using backup sensor")
				return getPurpleAirSensorData(ctx, rc, cfg, cfg.backupSensorID)
			}
			return 0, 0, errors.New("zero result for sensor returned from purpleair")
		}
		rtPM25Readings := make([]float64, len(data.Results))
		tenmPM25Readings := make([]float64, len(data.Results))
		for i := range data.Results {
			result := data.Results[i]
			ls := time.Unix(result.LastSeen, 0).UTC()
			log.Printf("sensor_id:%s last seen %s ago (%s)", sensorID, now().Sub(ls).Round(time.Second).String(), ls.Format(time.RFC1123))
			staleThreshold := now().Add(-(time.Minute * 10))
			if ls.Before(staleThreshold) {
				log.Printf("warning: stale data coming from sensor (last_seen: %s, sensor_id: %s)", ls.Format(time.RFC1123), sensorID)
				if cfg.backupSensorID != "" && sensorID != cfg.backupSensorID {
					log.Printf("using backup sensor (sensor_id: %s)", cfg.backupSensorID)
					return getPurpleAirSensorData(ctx, rc, cfg, cfg.backupSensorID)
				}
				return 0, 0, errors.Errorf("stale results returned from purpleair (sensor might be down, last_seen: %s)", ls.Format(time.RFC1123))
			}
			var sstats sensorData
			if err := json.Unmarshal([]byte(result.Stats), &sstats); err != nil {
				return 0, 0, errors.Wrap(err, "failed to json decode sensor data")
			}
			rtPM25Readings[i] = sstats.V
			tenmPM25Readings[i] = sstats.V1
		}
		return aqiFromPM(avg(rtPM25Readings)), aqiFromPM(avg(tenmPM25Readings)), nil
	}
	return 0, 0, errors.Errorf("unexpected status code returned (%s)", resp.Status)
}

func now() time.Time {
	return time.Now().UTC()
}

func avg(n []float64) float64 {
	total := float64(0)
	for _, nn := range n {
		total += nn
	}
	return total / float64(len(n))
}

type state struct {
	justStarted                   bool
	lastRTReading, last10mReading float64
}

const threshold = float64(65)

type aqiReadings struct {
	TenMAvg, RT float64
}

type notifier interface {
	notify(ctx context.Context, event string, readings aqiReadings) error
}

type smsNotifier struct {
	rc                          *retryablehttp.Client
	tfrom, tacctsid, tauthtoken string
	recipients                  []string
}

func (s *smsNotifier) notify(ctx context.Context, event string, readings aqiReadings) error {
	log.Printf("sms_send_notification: event = %s", event)
	ctx, cancel := context.WithTimeout(ctx, time.Second*30)
	defer cancel()
	message := ""
	switch event {
	case "air_quality_good":
		message = "📉👍 Nearby air quality seems to be getting better. Open windows for fresh air."
	case "air_quality_bad":
		message = "📈👎 Nearby air quality is getting bad. Close any open windows."
	default:
		return errors.Errorf("unknown notification event: '%s'", event)
	}
	message += "\n"
	message += fmt.Sprintf("(avg10_pm2.5: %.0f, rt_pm2.5: %.0f)", readings.TenMAvg, readings.RT)

	body := url.Values{}
	body.Set("Body", message)
	body.Set("From", s.tfrom)
	for _, n := range s.recipients {
		body.Set("To", strings.TrimSpace(n))
		req, _ := retryablehttp.NewRequest("POST", fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json", s.tacctsid), []byte(body.Encode()))
		req.Header.Set("User-Agent", "github.com/nkcmr/aqimon")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.SetBasicAuth(s.tacctsid, s.tauthtoken)
		req = req.WithContext(ctx)

		resp, err := s.rc.Do(req)
		if err != nil {
			return errors.Wrap(err, "failed to send http request to twilio")
		}
		defer resp.Body.Close()
		respBody, err := ioutil.ReadAll(resp.Body)
		if err != nil {
			return errors.Wrap(err, "failed to read http response from twilio")
		}
		if resp.StatusCode != http.StatusCreated {
			log.Printf("twilio return body: %s", respBody)
			return errors.Errorf("unexpected http status returned from twilio (%s)", resp.Status)
		}
		_ = respBody
	}
	return nil
}

type iftttNotifier struct {
	rc  *retryablehttp.Client
	key string
}

func (i *iftttNotifier) notify(ctx context.Context, event string, readings aqiReadings) error {
	log.Printf("ifttt_send_notification: event = %s", event)
	ctx, cancel := context.WithTimeout(ctx, time.Second*30)
	defer cancel()
	type iftttWHValues struct {
		Value1 string `json:"value1,omitempty"`
		Value2 string `json:"value2,omitempty"`
		Value3 string `json:"value3,omitempty"`
	}
	v := iftttWHValues{
		Value1: fmt.Sprintf("%.1f", readings.TenMAvg),
		Value2: fmt.Sprintf("%.1f", readings.RT),
	}
	dat, _ := json.Marshal(v)
	spew.Dump(v)
	req, _ := retryablehttp.NewRequest("POST", fmt.Sprintf("https://maker.ifttt.com/trigger/%s/with/key/%s", event, i.key), dat)
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "github.com/nkcmr/aqimon")
	resp, err := i.rc.Do(req)
	if err != nil {
		return errors.Wrap(err, "failed to send http request to ifttt")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(ioutil.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return errors.Errorf("non-ok status returned from ifttt (%s)", resp.Status)
	}
	return nil
}

func checkAirQuality(ctx context.Context, cfg config, s *state, rc *retryablehttp.Client, n notifier) error {
	log.Printf("checkAirQuality")
	rt, tenmavg, err := getPurpleAirSensorData(ctx, rc, cfg, cfg.purpleAirSensorID)
	if err != nil {
		return errors.Wrap(err, "failed to get purple air sensor data")
	}
	if !s.justStarted {
		log.Printf("previous_readings: rt = %.1f, 10m_avg = %.1f", s.lastRTReading, s.last10mReading)
	}
	log.Printf("current_readings: rt = %.1f, 10m_avg = %.1f", rt, tenmavg)
	defer func() {
		s.justStarted = false
		s.last10mReading = tenmavg
		s.lastRTReading = rt
	}()
	if s.justStarted {
		return nil
	}
	event := ""
	if s.last10mReading > threshold && tenmavg <= threshold {
		// aqi is improving! alert that it might be okay to open windows
		event = "air_quality_good"
	} else if s.last10mReading <= threshold && tenmavg > threshold {
		// aqi is getting worse :( send alert to close windows
		event = "air_quality_bad"
	} else {
		log.Printf("nothing to alert about")
		return nil
	}

	return errors.Wrap(n.notify(ctx, event, aqiReadings{
		TenMAvg: tenmavg,
		RT:      rt,
	}), "failed to send notification")
}

func main() {
	if err := _main(); err != nil {
		fmt.Fprintf(os.Stderr, "%s: error: %s\n", filepath.Base(os.Args[0]), err.Error())
		os.Exit(1)
	}
}

func aqiFromPM(pm float64) float64 {
	if math.IsNaN(pm) {
		return math.NaN()
	}
	if pm < 0 {
		return pm
	}
	if pm > 1000 {
		return math.NaN()
	}
	/*
	         Good                              0 - 50         0.0 - 15.0         0.0 – 12.0
	   Moderate                        51 - 100           >15.0 - 40        12.1 – 35.4
	   Unhealthy for Sensitive Groups   101 – 150     >40 – 65          35.5 – 55.4
	   Unhealthy                                 151 – 200         > 65 – 150       55.5 – 150.4
	   Very Unhealthy                    201 – 300 > 150 – 250     150.5 – 250.4
	   Hazardous                                 301 – 400         > 250 – 350     250.5 – 350.4
	   Hazardous                                 401 – 500         > 350 – 500     350.5 – 500
	*/
	if pm > 350.5 {
		return calcAQI(pm, 500, 401, 500, 350.5)
	} else if pm > 250.5 {
		return calcAQI(pm, 400, 301, 350.4, 250.5)
	} else if pm > 150.5 {
		return calcAQI(pm, 300, 201, 250.4, 150.5)
	} else if pm > 55.5 {
		return calcAQI(pm, 200, 151, 150.4, 55.5)
	} else if pm > 35.5 {
		return calcAQI(pm, 150, 101, 55.4, 35.5)
	} else if pm > 12.1 {
		return calcAQI(pm, 100, 51, 35.4, 12.1)
	} else if pm >= 0 {
		return calcAQI(pm, 50, 0, 12, 0)
	}
	return math.NaN()
}

func calcAQI(Cp, Ih, Il, BPh, BPl float64) float64 {
	var a = Ih - Il
	var b = BPh - BPl
	var c = Cp - BPl
	return math.Round((a/b)*c + Il)
}
