import urllib.request
import json

url = "http://localhost:3000/api/customers"
data = {
    "name": "Test Patient",
    "phone": "+919999999999",
    "preferred_slot": "22:30",
    "scheduled_date": "2026-06-16",
    "call_type": "REVIEW_CALL"
}

req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers={'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req) as response:
        print("STATUS:", response.status)
        print("RESPONSE:", response.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print("STATUS:", e.code)
    print("RESPONSE:", e.read().decode('utf-8'))
