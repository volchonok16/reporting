"""Disposable, isolated Docker startup proof; no shared Reporting services or data touched."""
import ipaddress, json, os, subprocess, tempfile, uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
API = r'''import hashlib, http.cookiejar, json, time, urllib.request, urllib.parse, uuid, os
from pathlib import Path
from kombu import Connection
origin = "http://127.0.0.1:8000"
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
csrf = None
def call(path, data=None, headers=None, method=None, raw=False):
    h = {"Origin": origin}
    if csrf: h["X-CSRF-Token"] = csrf
    h.update(headers or {})
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(origin+path, data=data, headers=h, method=method)
    with client.open(req, timeout=60) as response:
        result = response.read()
        return result if raw else json.loads(result)
csrf = call("/api/session")["csrf_token"]
def upload(rows):
    source = ("\ufeffINN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n" +
              "".join(f"7707083893;{79000000000+i};Тест;Test;0;1\n" for i in range(rows))).encode()
    boundary = "smoke"+uuid.uuid4().hex
    data = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n'
            'Content-Type: text/csv\r\n\r\n').encode()+source+f"\r\n--{boundary}--\r\n".encode()
    started = time.monotonic()
    received = call("/api/intakes?partner=RTK%20HUB", data, {
        "Content-Type": "multipart/form-data; boundary="+boundary, "X-Operation-ID": str(uuid.uuid4())})
    return {"id": received["result"]["intake"]["id"], "rows": rows, "bytes": len(source),
            "upload_seconds": round(time.monotonic()-started,3), "started": started}
def finish(item):
    deadline = time.monotonic()+100
    while time.monotonic()<deadline:
        state = call("/api/intakes/"+item["id"])
        phase = state.get("job",{}).get("state")
        if phase in {"PREPARED", "APPROVED"}: break
        if phase in {"FAILED","BLOCKED"}: raise AssertionError("Synthetic processing did not prepare: "+str(state))
        time.sleep(0.1)
    else: raise AssertionError("Synthetic processing timed out")
    base = "/api/cases/"+state["intake"]["case_id"]+"/revisions/"+state["revision"]["id"]
    bundle = call(base+"/artifacts")
    roles = {x["role"] for x in bundle["artifacts"]}
    assert roles == {"CLIENTS","DOGTAGS","NUMBERS","ZIP"}, roles
    if "manifest_hash" in item:
        assert bundle["manifest_hash"] == item["manifest_hash"], "Saved archive changed on restart"
    else:
        call("/api/cases/"+state["intake"]["case_id"]+"/approval",{
            "operation_id":str(uuid.uuid4()), "expected_revision_id":state["revision"]["id"],
            "manifest_hash":bundle["manifest_hash"]})
    numbers = next(x for x in bundle["artifacts"] if x["role"]=="NUMBERS")
    content = call(base+"/artifacts/"+numbers["id"]+"/download?"+urllib.parse.urlencode({
        "expected_revision_id": state["revision"]["id"],"manifest_hash":bundle["manifest_hash"]}),raw=True)
    assert content.count(b"\r\n")==item["rows"]+1
    digest = hashlib.sha256(content).hexdigest()
    if "sha256" in item: assert item["sha256"]==digest, "Output changed on restart"
    result = {k:v for k,v in item.items() if k!="started"}
    result.update(manifest_hash=bundle["manifest_hash"],sha256=digest,
                  end_to_end_seconds=round(time.monotonic()-item.get("started",time.monotonic()),3))
    return result
phase = os.environ.get("SMOKE_PHASE","process")
if phase=="process":
    for path in ("/run/dogtags-postgres/password","/run/dogtags-rabbitmq/password"):
        assert len(Path(path).read_text())>=64
    try:
        with Connection("amqp://dogtags:deliberately-invalid@dogtags-rabbitmq:5672//",connect_timeout=2) as broker:
            broker.ensure_connection(max_retries=0)
    except Exception: pass
    else: raise AssertionError("RabbitMQ accepted invalid credentials")
    print(json.dumps([finish(upload(n)) for n in (1,10000)]))
elif phase=="enqueue":
    print(json.dumps(upload(1)))
elif phase in {"verify","wait"}:
    data = json.loads(os.environ["SMOKE_ITEMS"])
    print(json.dumps([finish(item) for item in data]))
'''
def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        print(result.stdout[-5000:], flush=True)
        print(result.stderr[-5000:], flush=True)
        raise RuntimeError("Smoke command failed: "+str(args[:5]))
    return result.stdout
project = "dogtags-autostart-" + uuid.uuid4().hex[:10]
ids = run(["docker", "network", "ls", "-q"]).split()
networks = json.loads(run(["docker", "network", "inspect", *ids]))
used = [ipaddress.ip_network(c["Subnet"]) for n in networks
        for c in (n.get("IPAM", {}).get("Config") or []) if c.get("Subnet")]
subnets = []
for candidate in ipaddress.ip_network("198.19.0.0/16").subnets(new_prefix=28):
    if not any(candidate.version == net.version and candidate.overlaps(net) for net in used):
        subnets.append(str(candidate))
    if len(subnets) == 2:
        break
if len(subnets) != 2:
    raise RuntimeError("No free test-only Docker subnets; existing networks are left unchanged.")
with tempfile.TemporaryDirectory(prefix="dogtags-autostart-") as tmp:
    directory = Path(tmp)
    envfile = directory/"server.env"
    envfile.write_text("APP_PUBLIC_URL=http://t2product.ru\n")
    env = {k:v for k,v in os.environ.items() if not k.startswith(("COMPOSE_","DOGTAGS_","REPORTING_DOGTAGS_"))}
    env["COMPOSE_ENV_FILE"] = str(envfile)
    config = json.loads(run(["bash","-ec",'source scripts/resolve-compose.sh prod; "${COMPOSE[@]}" config --format json'],cwd=ROOT,env=env))
    config["name"] = project
    config["services"] = {k:v for k,v in config["services"].items() if k.startswith("dogtags-")}
    for service in config["services"].values(): service.pop("build",None)
    config["volumes"] = {k:{"name":project+"_"+k} for k in config["volumes"] if k.startswith("dogtags-")}
    config["networks"] = {k:{**v,"name":project+"_"+k} for k,v in config["networks"].items() if k.startswith("dogtags-")}
    for name, subnet in zip(config["networks"], subnets):
        config["networks"][name]["ipam"] = {"config": [{"subnet": subnet}]}
    composefile = directory/"compose.json"
    composefile.write_text(json.dumps(config))
    compose = ["docker","compose","-f",str(composefile),"-p",project]
    def dc(*args): return run(compose+list(args))
    def api(phase,items=None):
        args=["exec","-T","-e","SMOKE_PHASE="+phase]
        if items is not None: args+=["-e","SMOKE_ITEMS="+json.dumps(items)]
        args+=["dogtags-api","python","-"]
        return json.loads(run(compose+args,input=API))
    try:
        print("Starting isolated stack with no Dogtags environment settings...",flush=True)
        dc("up","-d","--no-build","--pull","never","--wait","--wait-timeout","90")
        print("First install started; running actual API -> RabbitMQ -> worker -> CSV download...",flush=True)
        items=api("process")
        print(json.dumps({"first_install":items}),flush=True)
        for service in ("dogtags-api","dogtags-worker","dogtags-postgres","dogtags-rabbitmq"):
            name=dc("ps","-q",service).strip()
            metadata=json.loads(run(["docker","inspect",name]))[0]
            assert not any(x.split("=",1)[0] in {"POSTGRES_PASSWORD","RABBITMQ_PASSWORD","RABBITMQ_DEFAULT_PASS"}
                           for x in metadata["Config"]["Env"])
            assert not metadata["HostConfig"]["PortBindings"]
        print("Restarting with existing data, saved secrets and still no passwords in env...",flush=True)
        dc("up","-d","--force-recreate","--no-build","--pull","never","--wait","--wait-timeout","90")
        api("verify",items)
        print("Saved archive and output hashes survived restart.",flush=True)
        dc("stop","dogtags-rabbitmq")
        queued=api("enqueue")
        dc("start","dogtags-rabbitmq")
        restored=api("wait",[queued])
        print(json.dumps({"broker_outage_recovered":restored}),flush=True)
        print("PASS: first install, restart, archive preservation, wrong-password rejection, no published ports and durable queue recovery.",flush=True)
    except Exception:
        print(dc("logs","--tail","30","dogtags-secrets","dogtags-init"), flush=True)
        raise
    finally:
        dc("down","-v","--remove-orphans")
