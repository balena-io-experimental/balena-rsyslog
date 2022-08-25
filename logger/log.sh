#!/usr/bin/env bash

MY_VAR="${TEST_VAR:=test}"
counter=0

while true; do
    echo "$MY_VAR $counter"
    ((counter++))
    sleep 5
done