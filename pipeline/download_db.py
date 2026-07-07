"""
download_db.py
Downloads cricket.duckdb from Cloudflare R2 to the local runner.
"""

import boto3
import os
from pathlib import Path

s3 = boto3.client(
    's3',
    endpoint_url=os.environ['R2_ENDPOINT_URL'],
    aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
    aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY']
)

DB_PATH = Path('data/cricket.duckdb')
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

print("Downloading cricket.duckdb from R2...")
s3.download_file('cricket-db', 'cricket.duckdb', str(DB_PATH))
print(f"Done. Saved to {DB_PATH}")