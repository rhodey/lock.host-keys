#!/bin/sh
set -e

export AWS_DEFAULT_REGION="$S3_REGION"
export AWS_ACCESS_KEY_ID="$S3_ACCESS"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET"

echo "make bucket"
aws --endpoint-url $S3_ENDPOINT s3 mb "s3://$S3_BUCKET" > /dev/null 2>&1 || true

echo "copy config"
aws --endpoint-url $S3_ENDPOINT s3 cp /khost/config.yml "s3://$S3_BUCKET/config.yml" > /dev/null 2>&1

echo "ok"
