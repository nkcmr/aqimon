package main

import (
	"context"
	"testing"

	"github.com/hashicorp/go-retryablehttp"
	"github.com/stretchr/testify/require"
)

func TestSMSNotifier(t *testing.T) {
	cfg := getEnvConfig()
	n, err := initNotifier(cfg, retryablehttp.NewClient())
	if err != nil {
		t.Skipf("cannot init notifier, skipping test (err: %s)", err)
		return
	}
	if _, ok := n.(*smsNotifier); !ok {
		t.Skipf("cannot init sms notifier, skipping test")
		return
	}
	err = n.notify(context.Background(), "air_quality_good", aqiReadings{
		TenMAvg: 64,
		RT:      63,
	})
	require.NoError(t, err)
}
