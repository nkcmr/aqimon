aqimon_linux_armv5:
	# building for raspberry pi
	GOOS=linux GOARCH=arm GOARM=5 go build -v -o ./$@ .

.PHONY: clean
clean:
	rm ./aqimon_linux_armv5
