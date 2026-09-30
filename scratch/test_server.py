import urllib.request

req = urllib.request.Request("http://localhost:3000/apresentacao-institucional.html")
with urllib.request.urlopen(req) as resp:
    html = resp.read().decode('utf-8')
    print("Status:", resp.status)
    print("Page Title in HTML:", "<title>" in html)
    print("Snippet:", html[:300])
