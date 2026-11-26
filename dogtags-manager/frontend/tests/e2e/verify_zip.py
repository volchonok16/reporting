"""Independent stdlib archive inspector. No application imports or fixture expectations."""
import base64
import json
from pathlib import Path
import sys
import zipfile

with zipfile.ZipFile(Path(sys.argv[1])) as archive:
    print(json.dumps([{ "name": name, "bytes": base64.b64encode(archive.read(name)).decode("ascii") }
                      for name in archive.namelist()]))
