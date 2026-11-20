import json
import struct
import sys
from collections import defaultdict, deque
from pathlib import Path

path = Path(sys.argv[1])
raw = path.read_bytes()
json_len = struct.unpack_from('<I', raw, 12)[0]
gltf = json.loads(raw[20:20 + json_len])
bin_start = 20 + json_len + 8


def read_accessor(index):
    accessor = gltf['accessors'][index]
    view = gltf['bufferViews'][accessor['bufferView']]
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    count = accessor['count']
    components = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}[accessor['type']]
    fmt = {5126: 'f', 5125: 'I', 5123: 'H'}[accessor['componentType']]
    stride = view.get('byteStride', components * struct.calcsize(fmt))
    return [struct.unpack_from('<' + fmt * components, raw, bin_start + start + i * stride) for i in range(count)]


primitive = gltf['meshes'][0]['primitives'][0]
positions = read_accessor(primitive['attributes']['POSITION'])
indices = [v[0] for v in read_accessor(primitive['indices'])]
welds = {}
parents = list(range(len(positions)))


def find(a):
    while parents[a] != a:
        parents[a] = parents[parents[a]]
        a = parents[a]
    return a


def union(a, b):
    a, b = find(a), find(b)
    if a != b:
        parents[b] = a


for i, p in enumerate(positions):
    key = tuple(round(v, 5) for v in p)
    if key in welds:
        union(i, welds[key])
    else:
        welds[key] = i
for i in range(0, len(indices), 3):
    union(indices[i], indices[i + 1])
    union(indices[i + 1], indices[i + 2])

components = defaultdict(list)
for i in range(len(positions)):
    components[find(i)].append(i)
print('components', len(components))
for root, vertices in sorted(components.items(), key=lambda item: -len(item[1]))[:30]:
    points = [positions[i] for i in vertices]
    mins = [min(p[a] for p in points) for a in range(3)]
    maxs = [max(p[a] for p in points) for a in range(3)]
    print(len(vertices), 'min', [round(v, 4) for v in mins], 'max', [round(v, 4) for v in maxs])
