#!/usr/bin/env python3
"""Targeted, read-only real-world sample presence, LRC and duplicate audit.

Run ON THE MAC MINI. The folder is local to that Mac, not mounted in ChatGPT.
No model runs, no writing into the selected music folder, no network requests.
"""
from __future__ import annotations
import argparse, hashlib, json, re, subprocess, sys, unicodedata
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from p040_smart_import import parse_lrc, probe, sha256

DEFAULT_ROOT='/Volumes/三星/网易云音乐/音乐（用于转换）'
DEFAULT_MANIFEST=HERE.parent/'docs'/'Real-Music-Samples.json'

def normalize(s: str) -> str:
    s=unicodedata.normalize('NFKC',s).casefold().strip()
    s=re.sub(r'[–—－−]','-',s)
    s=re.sub(r'\s*,\s*',',',s)
    s=re.sub(r'\s*-\s*','-',s)
    s=re.sub(r'\s+',' ',s)
    return s

def index_files(root: Path) -> dict[str, list[Path]]:
    results={}
    for p in root.rglob('*'):
        if not p.is_file() or p.is_symlink() or p.suffix.lower() not in {'.mp3','.m4a','.wav','.flac','.lrc'}:continue
        results.setdefault(normalize(p.name),[]).append(p)
    return results

def audit(root:Path, manifest:dict) -> dict:
    if not root.is_dir():
        return {'sourceRoot':str(root),'sourceAccessible':False,'error':'path-not-readable-or-volume-not-mounted','samples':[]}
    index=index_files(root)
    tests=[]
    for spec in manifest['samples']:
        group={'id':spec['id'],'scenario':spec['scenario'],'expected':spec['expected'],'optional':spec.get('optional',False),'files':[],'issues':[]}
        paths={'audio':[],'lyrics':[]}
        for kind,key in [('audio','audio'),('lyrics','lyrics')]:
            for name in spec.get(key,[]):
                hits=index.get(normalize(name),[])
                row={'requestedName':name,'kind':kind,'matches':[str(p.relative_to(root)) for p in hits]}
                if len(hits)==1:
                    p=hits[0]; paths[kind].append(p); row['state']='found';row['bytes']=p.stat().st_size
                    if kind=='audio':
                        item=probe(p);row['durationMs']=item['durationMs'];row['probeState']=item['probeState']
                        if item['probeState']=='invalid':group['issues'].append('audio-invalid')
                        row['sha256']=sha256(p)
                    else:
                        doc=parse_lrc(p);row['timedLines']=len(doc['timedLines']);row['hasTiming']=doc['hasTiming'];row['invalidTags']=doc['invalidTags'];row['maxStartMs']=doc['maxStartMs'];row['sha256']=sha256(p)
                        if not doc['hasTiming']:group['issues'].append('lyrics-no-usable-timestamps')
                        if doc['invalidTags']:group['issues'].append('lyrics-invalid-timestamps')
                else:
                    row['state']='missing' if not hits else 'ambiguous-location';group['issues'].append(f'{kind}-'+row['state'])
                group['files'].append(row)
        # LRC duration validation only for a single unambiguous audio/LRC pair.
        if len(paths['audio'])==1 and len(paths['lyrics'])==1:
            length=probe(paths['audio'][0])['durationMs']; lrc=parse_lrc(paths['lyrics'][0]);last=lrc['maxStartMs']
            if length is not None and last is not None and last>length+2000:
                group['issues'].append('lyrics-time-exceeds-duration')
            if normalize(paths['audio'][0].stem)!=normalize(paths['lyrics'][0].stem):
                group['issues'].append('different-artist-or-version-metadata-review')
        # Duplicates: same audio hash = exact duplicate; different = version collision.
        if len(paths['audio'])>1:
            hashes=[sha256(p) for p in paths['audio']]
            group['duplicateAudioState']='byte-identical' if len(set(hashes))==1 else 'same-title-different-audio-review'
            if len(set(hashes))!=1: group['issues'].append('do-not-merge-audio')
        if spec['expected']=='needs-review':group['issues'].append('explicit-artist-list-conflict')
        if spec['expected'] in {'duplicate-check','cover-duplicate-check'}:group['issues'].append('manual-version-decision-if-different-sha')
        if spec['expected']=='version-isolation-check':group['issues'].append('keep-8d-version-separate')
        group['issues']=list(dict.fromkeys(group['issues']))
        missing=any(f['state']!='found' for f in group['files'])
        group['state']='missing-files' if missing else ('needs-review' if group['issues'] else 'matched-preflight')
        tests.append(group)
    return {'schema':'p040.real-music-audit.v1','sourceRoot':str(root),'sourceAccessible':True,'readOnly':True,
            'summary':{'sampleGroups':len(tests),'presentGroups':sum(s['state']!='missing-files' for s in tests),'matchedPreflight':sum(s['state']=='matched-preflight' for s in tests),'needsReview':sum(s['state']=='needs-review' for s in tests),'missingFiles':sum(s['state']=='missing-files' for s in tests)},'samples':tests}

def main(argv=None):
    p=argparse.ArgumentParser(description='P040 real music samples, read-only audit')
    p.add_argument('--root',type=Path,default=Path(DEFAULT_ROOT))
    p.add_argument('--manifest',type=Path,default=DEFAULT_MANIFEST)
    p.add_argument('--report',type=Path,default=Path('/tmp/p040-real-music-audit.json'))
    args=p.parse_args(argv)
    data=json.loads(args.manifest.read_text(encoding='utf-8'))
    result=audit(args.root.expanduser(),data)
    if result['sourceAccessible']:
        out=args.report.expanduser().resolve();inp=args.root.expanduser().resolve()
        if out.is_relative_to(inp):p.error('--report must be outside music input directory')
        out.parent.mkdir(parents=True,exist_ok=True)
        out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='samples'},ensure_ascii=False,indent=2))
    if result['sourceAccessible']:
        for t in result['samples']:print(f"{t['id']} {t['state']}: {t['scenario']} | {', '.join(t['issues']) or 'no problems flagged'}")
    return 0 if result['sourceAccessible'] else 2

if __name__=='__main__':raise SystemExit(main())
