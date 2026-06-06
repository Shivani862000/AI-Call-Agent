#!/bin/sh
set -eu

: "${SERVER_NAME:?SERVER_NAME is required}"

sed "s/__SERVER_NAME__/${SERVER_NAME}/g" \
  /etc/nginx/templates/feedback-agent.conf.template \
  > /etc/nginx/conf.d/feedback-agent.conf
