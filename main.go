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
	"os"
	"path/filepath"
	"time"

	"code.nkcmr.net/sigcancel"
	"github.com/davecgh/go-spew/spew"
	"github.com/hashicorp/go-retryablehttp"
	"github.com/pkg/errors"
	"github.com/robfig/cron/v3"
)

// cli args
var (
	purpleAirSensorID string
	iftttWebhookKey   string
)

func _main() error {
	ctx, cancel := context.WithCancel(context.Background())
	go sigcancel.CancelOnSignal(cancel)

	fs := flag.NewFlagSet("aqimon", flag.ContinueOnError)
	fs.StringVar(&purpleAirSensorID, "sensor_id", os.Getenv("PURPLE_AIR_SENSOR_ID"), "ID of the purple air sensor to watch")
	fs.StringVar(&iftttWebhookKey, "ifttt_wh_key", os.Getenv("IFTTT_WH_KEY"), "Key for ifttt webhook")
	if err := fs.Parse(os.Args); err != nil {
		return errors.Wrap(err, "failed to parse cli flags")
	}

	rc := retryablehttp.NewClient()
	rc.HTTPClient.Timeout = time.Second * 5

	s := new(state)
	s.justStarted = true

	_ = checkAirQuality(ctx, s, rc)

	c := cron.New()
	_, _ = c.AddFunc("* * * * *", func() {
		if err := checkAirQuality(ctx, s, rc); err != nil {
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
	LastSeen                     int     `json:"LastSeen"`
	Type                         string  `json:"Type,omitempty"`
	Hidden                       string  `json:"Hidden"`
	DEVICEBRIGHTNESS             string  `json:"DEVICE_BRIGHTNESS,omitempty"`
	DEVICEHARDWAREDISCOVERED     string  `json:"DEVICE_HARDWAREDISCOVERED,omitempty"`
	DEVICEFIRMWAREVERSION        string  `json:"DEVICE_FIRMWAREVERSION,omitempty"`
	Version                      string  `json:"Version,omitempty"`
	LastUpdateCheck              int     `json:"LastUpdateCheck,omitempty"`
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

func getPurpleAirSensorData(ctx context.Context, rc *retryablehttp.Client, sensorID string) (rt, tenmavg float64, err error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second*30)
	defer cancel()
	req, _ := retryablehttp.NewRequest("GET", fmt.Sprintf("https://www.purpleair.com/json?show=%s", sensorID), nil)
	req = req.WithContext(ctx)
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
		rtPM25Readings := make([]float64, len(data.Results))
		tenmPM25Readings := make([]float64, len(data.Results))
		for i := range data.Results {
			var sstats sensorData
			if err := json.Unmarshal([]byte(data.Results[i].Stats), &sstats); err != nil {
				return 0, 0, errors.Wrap(err, "failed to json decode sensor data")
			}
			rtPM25Readings[i] = sstats.V
			tenmPM25Readings[i] = sstats.V1
		}
		return aqiFromPM(avg(rtPM25Readings)), aqiFromPM(avg(tenmPM25Readings)), nil
	}
	return 0, 0, errors.Errorf("unexpected status code returned (%s)", resp.Status)
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

type iftttWHValues struct {
	Value1 string `json:"value1,omitempty"`
	Value2 string `json:"value2,omitempty"`
	Value3 string `json:"value3,omitempty"`
}

func iftttAlert(ctx context.Context, rc *retryablehttp.Client, eventSlug string, whKey string, v iftttWHValues) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second*30)
	defer cancel()
	dat, _ := json.Marshal(v)
	spew.Dump(v)
	req, _ := retryablehttp.NewRequest("POST", fmt.Sprintf("https://maker.ifttt.com/trigger/%s/with/key/%s", eventSlug, whKey), dat)
	req = req.WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	resp, err := rc.Do(req)
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

func checkAirQuality(ctx context.Context, s *state, rc *retryablehttp.Client) error {
	log.Printf("checkAirQuality")
	rt, tenmavg, err := getPurpleAirSensorData(ctx, rc, purpleAirSensorID)
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
	if s.last10mReading > threshold && tenmavg <= threshold {
		// aqi is improving! alert that it might be okay to open windows
		if err := iftttAlert(ctx, rc, "air_quality_good", iftttWebhookKey, iftttWHValues{
			Value1: fmt.Sprintf("%.1f", tenmavg),
			Value2: fmt.Sprintf("%.1f", rt),
		}); err != nil {
			return errors.Wrap(err, "failed to send ifttt alert")
		}
	} else if s.last10mReading <= threshold && tenmavg > threshold {
		// aqi is getting worse :( send alert to close windows
		if err := iftttAlert(ctx, rc, "air_quality_bad", iftttWebhookKey, iftttWHValues{
			Value1: fmt.Sprintf("%.1f", tenmavg),
			Value2: fmt.Sprintf("%.1f", rt),
		}); err != nil {
			return errors.Wrap(err, "failed to send ifttt alert")
		}
	} else {
		log.Printf("nothing to alert about")
	}
	return nil
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
