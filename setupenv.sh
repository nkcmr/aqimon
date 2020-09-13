#!/bin/bash

printf "purple air sensor id: "
read -r PURPLE_AIR_SENSOR_ID

echo "available notifiers:"
echo "[a]: twilio"
echo "[b]: ifttt"
printf "pick one of the above by letter: "
read -r NOTIF_DECIDE



if [[ "$NOTIF_DECIDE" == "a" ]]
then
    echo "chose twilio!"
    printf "twilio account sid: "
    read -r TWILIO_ACCT_SID
    printf "twilio auth token: "
    read -r TWILIO_KEY
    printf "twilio from phone number: "
    read -r TWILIO_FROM_NUMBER
    printf "comma-delimited list of phone numbers to send to: "
    read -r SMS_RECIPIENTS

    echo "your env config: "
    echo "PURPLE_AIR_SENSOR_ID=$PURPLE_AIR_SENSOR_ID"
    echo "TWILIO_ACCT_SID=$TWILIO_ACCT_SID"
    echo "TWILIO_KEY=$TWILIO_KEY"
    echo "TWILIO_FROM_NUMBER=$TWILIO_FROM_NUMBER"
    echo "SMS_RECIPIENTS=$SMS_RECIPIENTS"

elif [[ "$NOTIF_DECIDE" == "b" ]]
then
    echo "chose ifttt!"
    printf "ifttt webhook key: "
    read -r IFTTT_WH_KEY

    echo "your env config: "
    echo "PURPLE_AIR_SENSOR_ID=$PURPLE_AIR_SENSOR_ID"
    echo "IFTTT_WH_KEY=$IFTTT_WH_KEY"
else
    echo "invalid notifier choice: '$NOTIF_DECIDE'"
    exit 1
fi
