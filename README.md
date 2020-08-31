# aqimon

a simple daemon that pulls [PurpleAir](https://www2.purpleair.com) sensor data and watches if AQI crosses a threshold, then sends [IFTTT](https://ifttt.com) webhooks about it. i use the webhooks to trigger iOS notifications that tell me when I can open/close my windows to let fresh air in.

## installation

i am running my daemon on a raspberry pi i have sitting around, so installation for that looks like this:

```
$ git clone https://github.com/nkcmr/aqimon.git
...
$ cd aqimond
$ make # requires >=go1.15
$ ls
README.md  aqimon_linux_armv5  go.mod  go.sum  main.go  makefile
```

copy the `aqimon_linux_armv5` to a raspberry pi, and i set up the daemon as a systemd service with this unit file:

```
[Unit]
Description=AQI Monitor Daemon
After=multi-user.target

[Service]
Type=idle
Environment=PURPLE_AIR_SENSOR_ID=<find your closest PurpleAir sensor ID>
Environment=IFTTT_WH_KEY=<put you IFTTT webhook key here>
Environment=DEADMAN_SNITCH=<use deadman snitch url[0] to make sure this doesn't stop working>
ExecStart=/home/pi/aqimon_linux_armv5
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

[0]: https://deadmanssnitch.com



## license

```
Copyright (c) 2020 Nicholas Comer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

