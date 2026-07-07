"""
alerts.py — reusable, best-effort email alert module for the data pipeline.

One entry point, `send_alert(subject, body_text)`, using the proven v1 Gmail
pattern (smtplib.SMTP_SSL over port 465). Reused by sheet_fetch.py,
check_ingest.py and report_new_unmatched.py — and by every future sheet the
owner adds.

Contract:
  * Best-effort: any failure while sending is logged LOUDLY to stderr and
    swallowed. Sending an alert must NEVER crash the caller — an alerting
    outage can never take down the pipeline.
  * Dry-run: when env ALERTS_DRY_RUN=1, the email is printed to stdout instead
    of being sent. All local testing runs with this set; a real email is never
    sent during development.
  * Subject is always prefixed with "[cricket-dashboard] ".

Env (only read when actually sending, i.e. not dry-run):
  GMAIL_ADDRESS       — sender + SMTP login user
  GMAIL_APP_PASSWORD  — SMTP app password
  ALERT_EMAIL         — recipient
"""

import os
import smtplib
import sys
from email.mime.text import MIMEText

SUBJECT_PREFIX = "[cricket-dashboard] "


def send_alert(subject, body_text):
    """Send an alert email (or print it in dry-run mode).

    Returns True if the email was sent (or printed in dry-run), False if a real
    send was attempted and failed. Never raises.
    """
    full_subject = SUBJECT_PREFIX + subject

    if os.environ.get("ALERTS_DRY_RUN") == "1":
        print("=== ALERTS_DRY_RUN=1 — email NOT sent, printing instead ===")
        print(f"To:      {os.environ.get('ALERT_EMAIL', '<ALERT_EMAIL unset>')}")
        print(f"Subject: {full_subject}")
        print("---")
        print(body_text)
        print("=== end dry-run email ===")
        return True

    try:
        gmail_address = os.environ["GMAIL_ADDRESS"]
        app_password = os.environ["GMAIL_APP_PASSWORD"]
        recipient = os.environ["ALERT_EMAIL"]

        msg = MIMEText(body_text)
        msg["Subject"] = full_subject
        msg["From"] = gmail_address
        msg["To"] = recipient

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(gmail_address, app_password)
            server.sendmail(gmail_address, [recipient], msg.as_string())

        print(f"Alert email sent to {recipient}: {full_subject}")
        return True
    except Exception as e:  # noqa: BLE001 — best-effort by design
        print(
            f"!!! ALERT EMAIL FAILED (non-fatal): {e!r}\n"
            f"!!! subject was: {full_subject}",
            file=sys.stderr,
        )
        return False
