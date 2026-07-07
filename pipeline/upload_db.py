"""
upload_db.py
Uploads the updated cricket.duckdb back to Cloudflare R2.
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

if not DB_PATH.exists():
    raise FileNotFoundError(f"Database not found at {DB_PATH}")

print("Uploading cricket.duckdb to R2...")
s3.upload_file(str(DB_PATH), 'cricket-db', 'cricket.duckdb')
print("Done.")