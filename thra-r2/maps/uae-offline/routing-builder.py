#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c)2026 TRV / ALTENEIJI. See routing-NOTICE.txt.
"""Build the independently generated, ODbL UAE routing data for TRV.

This builder consumes complete OSM objects, never Organic Maps code or MWM.
Unsupported restrictions and restricted/conditional access are excluded rather
than silently ignored. Output is a mapped-road/track graph, not a terrain model.
"""
from __future__ import annotations

import argparse
import array
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import osmium
from shapely import wkb
from shapely.geometry import LineString, Point, mapping
from shapely.prepared import prep

ROAD = set("motorway trunk primary secondary tertiary unclassified residential living_street service road motorway_link trunk_link primary_link secondary_link tertiary_link".split())
TRACK = {"track"}
ALLOWED_ACCESS = {"yes", "permissive", "designated", "official"}
ACCESS_KEYS = ("motorcar", "motor_vehicle", "vehicle", "access")
SPEED = {"motorway": 100, "trunk": 80, "primary": 60, "secondary": 50, "tertiary": 40, "residential": 30, "living_street": 10, "service": 15, "track": 15, "road": 25, "unclassified": 30}
RETAIN = {"highway", "surface", "smoothness", "tracktype", "oneway", "junction", "maxspeed", "ford", "impassable", "construction", "area", "barrier", "locked", "name", "name:en", "name:ar"}


def metres(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 12742000 * math.asin(min(1, math.sqrt(h)))


def access(tags, direction=None):
    if direction:
        for k in ACCESS_KEYS:
            if k+":"+direction in tags:
                return tags[k+":"+direction] in ALLOWED_ACCESS
    for k in ACCESS_KEYS:
        if k in tags:
            return tags[k] in ALLOWED_ACCESS
    return True


def profile(tags):
    hw = tags.get("highway")
    if hw not in ROAD | TRACK:
        return None, "non_motor_highway"
    # A fixed vehicle dimension is not known. Never assert clearance through
    # an explicitly dimension/weight-restricted edge or unevaluated condition.
    if any("conditional" in k for k in tags):
        return None, "conditional"
    if any(k.startswith(("maxheight", "maxwidth", "maxweight", "maxaxleload", "maxlength")) for k in tags):
        return None, "vehicle_dimension"
    if tags.get("construction") or tags.get("impassable") == "yes" or tags.get("area") == "yes":
        return None, "construction_impassable_area"
    if tags.get("smoothness") in {"impassable", "very_horrible", "horrible"}:
        return None, "surface_impassable"
    if not access(tags) and not any(access(tags, d) for d in ("forward", "backward")):
        return None, "access"
    is_track = hw in TRACK or tags.get("surface") in {"sand", "dirt", "earth", "mud", "ground", "grass", "gravel", "fine_gravel", "unpaved", "pebblestone", "compacted"} or tags.get("ford") == "yes"
    mask = 2 if is_track else 3
    oneway = next((tags[k] for k in ("oneway:motorcar", "oneway:motor_vehicle", "oneway:vehicle", "oneway") if k in tags), "yes" if tags.get("junction") == "roundabout" or hw in {"motorway", "motorway_link"} else "no")
    if oneway not in {"yes", "1", "true", "no", "0", "false", "-1", "reverse"}:
        return None, "unsupported_oneway"
    directions = []
    if oneway not in {"-1", "reverse"} and access(tags, "forward"):
        directions.append(1)
    if oneway not in {"yes", "1", "true"} and access(tags, "backward"):
        directions.append(-1)
    if not directions:
        return None, "directional_access"
    speed = SPEED.get(hw, SPEED.get(hw.removesuffix("_link"), 30))
    value = tags.get("maxspeed", "")
    try:
        n = float(value.removesuffix(" mph"))
        if "mph" in value:
            n *= 1.609344
        if math.isfinite(n) and n > 0:
            speed = min(speed, n)
    except ValueError:
        pass
    if is_track:
        speed = min(speed, 15)
    return (mask, int(is_track), directions, max(5, min(120, speed))), None


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []
        self.restrictions = []
        self.blocked_nodes = set()
        self.country = None
        self.counts = Counter()

    def node(self, n):
        t = dict(n.tags)
        if t.get("barrier") not in {None, "no", "entrance", "cattle_grid"} or not access(t) or t.get("locked") == "yes" or any("conditional" in k for k in t):
            self.blocked_nodes.add(n.id)

    def way(self, w):
        if "highway" not in w.tags:
            return
        self.counts["source_highway_ways"] += 1
        tags = {k: v for k, v in w.tags if k in RETAIN or k.startswith(ACCESS_KEYS + ("oneway:", "maxheight", "maxwidth", "maxweight", "maxaxleload", "maxlength")) or "conditional" in k}
        p, reason = profile(tags)
        if p is None:
            self.counts["excluded_"+reason] += 1
            return
        try:
            nodes = [(n.ref, n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            self.counts["excluded_missing_location"] += 1
            return
        if len(nodes) >= 2:
            self.ways.append((w.id, nodes, tags, p))

    def relation(self, r):
        if r.tags.get("type") == "restriction" or any(k.startswith("restriction") for k, v in r.tags):
            self.restrictions.append((r.id, dict(r.tags), [(m.type, m.ref, m.role) for m in r.members]))

    def area(self, a):
        if a.from_way() or a.orig_id() != 307763:
            return
        if a.tags.get("ISO3166-1") != "AE" or a.tags.get("admin_level") != "2":
            raise RuntimeError("Unexpected country relation identity")
        self.country = wkb.loads(osmium.geom.WKBFactory().create_multipolygon(a), hex=True)


def restriction_plan(relations, counts):
    accepted, excluded_ways = [], set()
    for rid, tags, members in relations:
        types = [tags[k] for k in ("restriction:motorcar", "restriction:motor_vehicle", "restriction:vehicle", "restriction") if k in tags]
        if not types:
            if any(k in tags for k in ("restriction:conditional", "restriction:motorcar:conditional", "restriction:motor_vehicle:conditional", "restriction:vehicle:conditional")):
                counts["restriction_unsupported_relations"] += 1
                excluded_ways.update(ref for typ, ref, role in members if typ == "w")
            else:
                counts["restriction_non_motor_only"] += 1
            continue
        if set(tags.get("except", "").replace(",", ";").split(";")) & {"motorcar", "motor_vehicle", "vehicle"}:
            counts["restriction_except_motorcar"] += 1
            continue
        rule = types[0]
        fr = [ref for typ, ref, role in members if typ == "w" and role == "from"]
        to = [ref for typ, ref, role in members if typ == "w" and role == "to"]
        via = [ref for typ, ref, role in members if typ == "n" and role == "via"]
        unsupported = any("conditional" in k for k in tags) or len(via) != 1 or any(typ == "w" and role == "via" for typ, ref, role in members) or not fr or not to or rule not in {"no_left_turn", "no_right_turn", "no_straight_on", "no_u_turn", "no_entry", "no_exit", "only_left_turn", "only_right_turn", "only_straight_on", "only_u_turn"}
        if set(fr) & set(to) and rule not in {"no_u_turn", "only_u_turn", "no_straight_on", "only_straight_on"}:
            unsupported = True
        if unsupported:
            counts["restriction_unsupported_relations"] += 1
            excluded_ways.update(ref for typ, ref, role in members if typ == "w")
            continue
        accepted.append((rid, rule, fr, to, via[0]))
    counts["restriction_excluded_way_ids"] = len(excluded_ways)
    return accepted, excluded_ways


def build(source, out, evidence, verify_source=False):
    if verify_source:
        if source.stat().st_size != 256095041 or hashlib.sha256(source.read_bytes()).hexdigest() != '7624e9e360053e1dff0c39efd3e984c3b188404d86a6500f0d8ffa963685be47':
            raise RuntimeError('Input is not the verified frozen official GCC261023 extract. Update the reviewed data recipe before using another extract.')
    c = Collector()
    # The area assembler reads complete member ways and inner rings; filter
    # candidate relations to AE while preserving the whole source stream.
    processor = osmium.FileProcessor(str(source)).with_areas(osmium.filter.TagFilter(("ISO3166-1", "AE"))).with_filter(osmium.filter.KeyFilter("highway", "barrier", "access", "vehicle", "motor_vehicle", "motorcar", "locked", "access:conditional", "vehicle:conditional", "motor_vehicle:conditional", "motorcar:conditional", "type", "restriction", "ISO3166-1"))
    for obj in processor:
        if obj.is_node(): c.node(obj)
        elif obj.is_way(): c.way(obj)
        elif obj.is_relation(): c.relation(obj)
        elif obj.is_area(): c.area(obj)
    boundary = c.country
    if boundary is None or boundary.is_empty or not boundary.is_valid:
        raise RuntimeError("Missing or invalid complete AE national boundary")
    prepared = prep(boundary)
    out.mkdir(parents=True, exist_ok=True)
    (out/"routing-boundary.geojson").write_text(json.dumps({"type":"Feature", "properties":{"ISO3166-1":"AE","osmRelation":307763,"license":"ODbL-1.0"},"geometry":mapping(boundary)},separators=(",", ":"))+"\n")
    rules, exclude_ways = restriction_plan(c.restrictions, c.counts)
    chunks = []
    for wid, nodes, tags, p in c.ways:
        if wid in exclude_ways:
            c.counts["excluded_unsupported_restriction_ways"] += 1
            continue
        line = LineString([(lon, lat) for nid, lon, lat in nodes])
        if prepared.covers(line) and not any(n[0] in c.blocked_nodes for n in nodes):
            chunks.append((wid, nodes, tags, p))
            c.counts["country_complete_ways"] += 1
            continue
        if not prepared.intersects(line):
            c.counts["outside_country_ways"] += 1
            continue
        # Never route through foreign enclaves or bridge across a boundary.
        # Partial ways retain every original point of each covered segment;
        # border-crossing segments are conservatively omitted, not connected.
        c.counts["country_partial_or_barrier_ways"] += 1
        run = []
        for a, b in zip(nodes, nodes[1:]):
            good = a[0] not in c.blocked_nodes and b[0] not in c.blocked_nodes and prepared.covers(LineString([(a[1],a[2]),(b[1],b[2])]))
            if good:
                if not run: run=[a]
                run.append(b)
            else:
                c.counts["excluded_foreign_or_barrier_segments"] += 1
                if len(run)>1: chunks.append((wid,run,tags,p))
                run=[]
        if len(run)>1: chunks.append((wid,run,tags,p))
    print(json.dumps({"stage":"country-filter","candidateWays":len(c.ways),"chunks":len(chunks),"bounds":boundary.bounds,"counts":c.counts}), flush=True)
    use = Counter(nid for wid, nodes, tags, p in chunks for nid, lon, lat in nodes)
    special = {via for rid, rule, fr, to, via in rules}
    coords, raw_edges = {}, []
    for wid, nodes, tags, (mask, kind, dirs, speed) in chunks:
        start, length = 0, 0.0
        for i in range(1,len(nodes)):
            length += metres(nodes[i-1][1:], nodes[i][1:])
            if i == len(nodes)-1 or use[nodes[i][0]]>1 or nodes[i][0] in special or i-start>=127 or length>=2000:
                geom=nodes[start:i+1]
                pieces=[geom]
                if geom[0][0]==geom[-1][0] and len(geom)>=3:
                    # A closed ring with only one attached junction is still
                    # real mapped road. Split it at an existing OSM shape
                    # node so CSR never loses the ring as a zero-endpoint edge.
                    mid=len(geom)//2
                    pieces=[geom[:mid+1],geom[mid:]]
                    c.counts['closed_ring_pieces_retained']+=2
                for piece in pieces:
                    a,b=piece[0][0],piece[-1][0]
                    dist=sum(metres(x[1:],y[1:]) for x,y in zip(piece,piece[1:]))
                    if dist>0.05 and a!=b:
                        coords[a]=piece[0][1:];coords[b]=piece[-1][1:]
                        for d in dirs:
                            shape=piece if d==1 else list(reversed(piece))
                            raw_edges.append((shape[0][0],shape[-1][0],dist, dist/(speed/3.6),mask,kind,wid,shape))
                start=i;length=0.0
    ids=sorted(coords); index={nid:i for i,nid in enumerate(ids)}
    raw_edges.sort(key=lambda e:(index[e[0]],index[e[1]],e[6]))
    n,e=len(ids),len(raw_edges)
    if n>2_000_000 or e>1_500_000: raise RuntimeError(f"Graph runtime size cap exceeded N={n} E={e}")
    lat=array.array('i',(round(coords[nid][1]*1e7) for nid in ids));lon=array.array('i',(round(coords[nid][0]*1e7) for nid in ids))
    offsets=array.array('I',[0])*(n+1)
    for edge in raw_edges: offsets[index[edge[0]]+1]+=1
    for i in range(n): offsets[i+1]+=offsets[i]
    targets=array.array('I');distance=array.array('f');seconds=array.array('f');masks=array.array('B');kinds=array.array('B');go=array.array('I',[0]);glat=array.array('i');glon=array.array('i')
    incoming=defaultdict(list);outgoing=defaultdict(list)
    for ei,(a,b,dist,secs,mask,kind,wid,shape) in enumerate(raw_edges):
        targets.append(index[b]);distance.append(dist);seconds.append(secs);masks.append(mask);kinds.append(kind)
        glat.extend(round(t[2]*1e7) for t in shape);glon.extend(round(t[1]*1e7) for t in shape);go.append(len(glat))
        incoming[b].append(ei);outgoing[a].append(ei)
    blocked=set();applied=[]
    for rid,rule,fr,to,via in rules:
        ins=[i for i in incoming.get(via,[]) if raw_edges[i][6] in fr]
        outs=outgoing.get(via,[])
        if not ins or (rule.startswith("no_") and not any(raw_edges[i][6] in to for i in outs)):
            c.counts["restriction_not_in_filtered_graph"]+=1;continue
        added=[]
        for ie in ins:
            matching={oe for oe in outs if raw_edges[oe][6] in to}
            if set(fr)&set(to):
                if rule.endswith("u_turn"): matching={oe for oe in matching if raw_edges[oe][1]==raw_edges[ie][0]}
                elif rule.endswith("straight_on"): matching={oe for oe in matching if raw_edges[oe][1]!=raw_edges[ie][0]}
            for oe in outs:
                if (rule.startswith("no_") and oe in matching) or (rule.startswith("only_") and oe not in matching):
                    blocked.add((ie,oe));added.append([ie,oe])
        if added: applied.append({"osmRelation":rid,"rule":rule,"viaNode":via,"blockedTransitions":added})
    pairs=sorted(blocked)
    fields=[('latE7',lat,'i32'),('lonE7',lon,'i32'),('offsets',offsets,'u32'),('targets',targets,'u32'),('distanceM',distance,'f32'),('seconds',seconds,'f32'),('mask',masks,'u8'),('kind',kinds,'u8'),('geomOffsets',go,'u32'),('geomLatE7',glat,'i32'),('geomLonE7',glon,'i32'),('restrictionFrom',array.array('I',(a for a,b in pairs)),'u32'),('restrictionTo',array.array('I',(b for a,b in pairs)),'u32')]
    graph=bytearray(64);graph[:8]=b'TRVG0001';struct.pack_into('<5I',graph,8,1,n,e,len(glat),len(pairs));layout={}
    for name, values, typ in fields:
        while len(graph)%4: graph.append(0)
        layout[name]={"offset":len(graph),"count":len(values),"type":typ}
        if sys.byteorder!='little' and values.itemsize>1: values.byteswap()
        graph.extend(values.tobytes())
    if len(graph)>100*1024*1024: raise RuntimeError("Graph binary exceeds100MiB cap")
    temporary=out/'routing-graph.bin.tmp'
    temporary.write_bytes(graph);temporary.replace(out/'routing-graph.bin')
    west,south,east,north=boundary.bounds
    manifest={"datasetId":"uae-osm-2026-10-23-trvg1","schemaVersion":1,"bounds":{"south":south,"west":west,"north":north,"east":east},"graph":{"file":"routing-graph.bin","bytes":len(graph),"sha256":hashlib.sha256(graph).hexdigest()},"counts":{"nodes":n,"edges":e,"points":len(glat),"restrictions":len(pairs)},"layout":layout,"generatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),"sourceDate":"2026-10-23T20:20:51Z","attribution":"© OpenStreetMap contributors","attributionUrl":"https://www.openstreetmap.org/copyright","license":"ODbL-1.0","licenseUrl":"https://opendatacommons.org/licenses/odbl/1-0/","source":{"file":"gcc-states-261023.osm.pbf","url":"https://download.geofabrik.de/asia/gcc-states-261023.osm.pbf","sha256":hashlib.sha256(source.read_bytes()).hexdigest(),"bytes":source.stat().st_size,"countryRelation":307763},"profiles":{"road":{"mask":1,"description":"Mapped public motorcar roads, unpaved/ford/track excluded; dimension-restricted and conditional access conservatively excluded."},"fourWheelDrive":{"mask":2,"description":"Mapped permitted motorcar roads and mapped tracks; track/surface data does not verify passability, terrain safety or motorhome suitability."}},"estimates":"Seconds are static conservative class-speed estimates capped by numeric maxspeed, not live traffic, turn costs or verified travel time. Track cap15km/h.","coverage":"Exact AE OSM admin_level2 relation with islands/inner rings. Foreign or barrier crossing original segments omitted. No cross-border shortcuts or unmapped desert routing.","processingCounts":dict(c.counts),"excludedUnsupportedTurnRules":"Affected member ways removed for via-way, conditional, malformed and unsupported same-way turn rules.","geometry":"Full original OSM geometry retained including edge endpoints; nonjunction nodes collapsed, split at127segments or2km. Opposite edges have reversed geometry. Grade-separated crossings connect only by shared OSM nodeID."}
    boundary_file=out/'routing-boundary.geojson'
    manifest['boundary']={'file':'routing-boundary.geojson','bytes':boundary_file.stat().st_size,'sha256':hashlib.sha256(boundary_file.read_bytes()).hexdigest()}
    temporary=out/'routing-manifest.json.tmp'
    temporary.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');temporary.replace(out/'routing-manifest.json')
    (evidence/'graph-restriction-fixtures.json').write_text(json.dumps({"appliedRelations":applied,"counts":dict(c.counts),"boundaryValid":boundary.is_valid,"boundaryType":boundary.geom_type,"boundaryParts":len(boundary.geoms) if hasattr(boundary,'geoms') else 1,"blockedNodeCountSource":len(c.blocked_nodes),"profileEdgeCounts":dict(Counter(str(x) for x in masks)),"sourceNonCountryWayCount":c.counts['outside_country_ways']},indent=2)+'\n')
    # Public point fixtures, deliberately separate from the user's real GPS.
    places={"Abu Dhabi":{"latitude":24.4539,"longitude":54.3773},"Dubai":{"latitude":25.2048,"longitude":55.2708},"Al Ain":{"latitude":24.2075,"longitude":55.7447},"Madinat Zayed":{"latitude":23.6527,"longitude":53.6536},"Liwa":{"latitude":23.13333,"longitude":53.75},"Sharjah":{"latitude":25.3463,"longitude":55.4209},"Fujairah":{"latitude":25.1288,"longitude":56.3265},"Ras Al Khaimah":{"latitude":25.7895,"longitude":55.9432},"Empty Quarter no-mapped-road probe":{"latitude":22.8,"longitude":53.3}}
    (out/'routing-public-fixtures.json').write_text(json.dumps({"places":places,"pairs":[{"from":"Abu Dhabi","to":"Dubai","profile":"road"},{"from":"Abu Dhabi","to":"Madinat Zayed","profile":"road"},{"from":"Madinat Zayed","to":"Liwa","profile":"fourWheelDrive"},{"from":"Dubai","to":"Fujairah","profile":"road"}],"negativeProbe":"Empty Quarter no-mapped-road probe must never produce an invented connector. Check actual snap/network result; no fixed reachability is asserted.","restrictions":applied[:25]},indent=2)+'\n')
    print(json.dumps({"stage":"complete","counts":manifest['counts'],"bytes":len(graph),"sha256":manifest['graph']['sha256'],"layout":layout}),flush=True)
    return manifest


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);ap.add_argument('--evidence',type=Path,required=True);args=ap.parse_args()
    args.evidence.mkdir(parents=True,exist_ok=True)
    build(args.source,args.out,args.evidence,verify_source=True)
