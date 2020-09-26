aqimon_linux_armv5: $(wildcard *.go)
	# building for raspberry pi
	GOOS=linux GOARCH=arm GOARM=5 go build -v -o ./$@ .

.PHONY: clean
clean:
	rm ./aqimon_linux_armv5
