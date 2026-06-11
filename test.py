import urllib.request

try:
    response = urllib.request.urlopen('http://localhost:3000/api/feedback/analytics')
    print(response.read().decode('utf-8'))
except Exception as e:
    print(e)
