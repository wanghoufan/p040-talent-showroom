#!/usr/bin/env python3
"""P040 local AI import preflight and optional accompaniment EXTRACT adapter.

Default scan mode is READ ONLY for every input media file. No model or network is used.
P040 owner-supplied MP3/FLAC/M4A/WAV and LRC files are matched conservatively;
ambiguous identities never get attached automatically. The optional `extract` mode
requires audio-separator installed in the host macOS environment and writes to a
separate output directory. Original recordings are never edited.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import hashlib
import json
import re
import shutil
import subprocess
import unicodedata
import uuid
from pathlib import Path
from typing import Any

AUDIO_EXT = {'.mp3', '.m4a', '.wav', '.flac'}
ALL_EXT = AUDIO_EXT | {'.lrc'}
ROLE_END = re.compile(r'(?:\s*[-_. ]+\s*|\s*\()(?:伴奏|instrumental|karaoke|backing(?:[\s-]*track)?|原唱|原声|original|guide|vocals?)(?:\s*\))?$', re.I)
ACCOMP = re.compile(r'(?:伴奏|instrumental|karaoke|backing(?:[\s-]*track)?)', re.I)
# These denote genuinely different versions; do NOT collapse them for automatic pairing.
VERSION = re.compile(r'(?i)\b(?:8d(?:\s+audio)?|live|remix|cover|radio\s+edit|acoustic|sped\s+up|slowed|nightcore|demo|instrumental)\b|翻唱|现场版|混音版')
COPY_SUFFIX = re.compile(r'\s*\(([0-9]+)\)\s*$')
TIME = re.compile(r'\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]')
META = re.compile(r'^\[(ar|ti|al|offset|by|length):([^\]]*)\]\s*$', re.I)
ID_NS = uuid.UUID('630cf7b7-e9fa-48ac-adc5-c8b983f1d8d5')


def canonical(s: str) -> str:
    s = unicodedata.normalize('NFKC', s).casefold()
    s = s.replace('（', '(').replace('）', ')')
    s = re.sub(r'[–—－−]', '-', s)
    s = re.sub(r'\s*,\s*', ',', s)
    s = re.sub(r'\s*[-]\s*', ' - ', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


def strip_copy_num(stem: str) -> str:
    # (1), (2) are Finder copy-suffixes; version qualifiers, e.g. (8D Audio), are NOT.
    return COPY_SUFFIX.sub('', stem).strip()


def audio_role(stem: str) -> tuple[str, str]:
    m = ROLE_END.search(stem)
    if not m:
        return stem.strip(), 'unmarked'
    role = 'accompaniment' if ACCOMP.search(m.group(0)) else 'original'
    return stem[:m.start()].rstrip(' _-.('), role


def name_identity(name: str) -> dict[str, str]:
    stem = Path(name).stem
    copy_match = COPY_SUFFIX.search(stem)
    base, role = audio_role(strip_copy_num(stem))
    no_copy = base
    parts = re.split(r'\s+[-–—]\s+', no_copy, maxsplit=1)
    artist, title = (parts[0], parts[1]) if len(parts) == 2 else ('', no_copy)
    # A dash WITH whitespace is the canonical artist / title separator. A dash
    # without whitespace inside a title is not necessarily a delimiter.
    return {'stem':stem,'base':no_copy,'artist':artist.strip(),'title':title.strip(),
            'artistKey':canonical(artist),'titleKey':canonical(title), 'key':canonical(no_copy),
            'role':role,'copyNumber':str(copy_match.group(1)) if copy_match else ''}


def sha256(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
    return h.hexdigest()


def probe(path: Path) -> dict[str, Any]:
    """Optional ffprobe; absence or invalid media is reported, not guessed."""
    if not shutil.which('ffprobe'):
        return {'durationMs':None,'tags':{},'probeState':'not-installed'}
    try:
        p=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:format_tags=artist,title','-of','json',str(path)],
                         capture_output=True,text=True,timeout=18,check=True)
        f=json.loads(p.stdout or '{}').get('format',{})
        dur=float(f.get('duration',0))
        tags={str(k).lower():str(v) for k,v in (f.get('tags') or {}).items()}
        return {'durationMs':int(dur*1000) if dur>0 else None,'tags':tags,'probeState':'ok' if dur>0 else 'invalid'}
    except (subprocess.CalledProcessError,TimeoutError,ValueError,json.JSONDecodeError,subprocess.TimeoutExpired):
        return {'durationMs':None,'tags':{},'probeState':'invalid'}


def parse_lrc(path: Path) -> dict[str, Any]:
    raw=path.read_text('utf-8-sig',errors='replace')
    meta:dict[str,str]={}
    timed:list[dict[str,Any]]=[]
    words=[]
    bad=0
    for line in raw.splitlines():
        line=line.strip()
        mm=META.match(line)
        if mm:
            meta[mm.group(1).lower()]=mm.group(2).strip();continue
        stamps=list(TIME.finditer(line))
        if not stamps:
            if line and not line.startswith('['):words.append(line)
            elif line and line.startswith('['):bad+=1
            continue
        txt=TIME.sub('',line).strip()
        for st in stamps:
            minute=int(st.group(1));second=int(st.group(2));dec=st.group(3) or '0'
            if second>59:bad+=1;continue
            fraction=int((dec+'000')[:3]) if len(dec)==3 else (int(dec)*100 if len(dec)==1 else int(dec)*10)
            timed.append({'startMs':(minute*60+second)*1000+fraction,'text':txt})
    try:offset=int(meta.get('offset','0'))
    except ValueError:offset=0;bad+=1
    for t in timed:t['startMs']=max(0,t['startMs']+offset)
    timed.sort(key=lambda t:t['startMs'])
    return {'metadata':meta,'timedLines':timed,'plainLines':words,'invalidTags':bad,
            'hasTiming':bool(timed),'maxStartMs':timed[-1]['startMs'] if timed else None}


def list_source_files(root: Path) -> list[Path]:
    if not root.is_dir(): raise ValueError(f'Not a folder: {root}')
    # Never follow symlinks; no read escapes selected user folder.
    return sorted((p for p in root.rglob('*') if p.is_file() and not p.is_symlink() and p.suffix.lower() in ALL_EXT),
                  key=lambda p:str(p).casefold())


def scan(root: Path) -> dict[str,Any]:
    root=root.expanduser().resolve(strict=True)
    files=list_source_files(root)
    audio=[]; lrc=[]; dedup=defaultdict(list); duplicate_lyrics=[]
    for p in files:
        identity=name_identity(p.name)
        entry={'name':p.name,'path':str(p),'relPath':str(p.relative_to(root)),**identity}
        if p.suffix.lower()=='.lrc':
            entry['lrc']=parse_lrc(p);entry['hash']=sha256(p);lrc.append(entry)
        else:
            entry['hash']=sha256(p);entry['probe']=probe(p)
            dedup[entry['hash']].append(entry)
            audio.append(entry)
    # No silent duplicate overwrite. Same hash may appear under multiple copy names;
    # only one is imported, and other aliases are reported.
    # Identical LRC copies are not ambiguities; different content with the
    # same normalized name is an ambiguity and needs review.
    lyric_hash_groups=defaultdict(list)
    for e in lrc: lyric_hash_groups[e['hash']].append(e)
    lrc=[]
    for group in lyric_hash_groups.values():
        chosen=sorted(group,key=lambda e:(bool(e['copyNumber']),len(e['relPath']),e['relPath']))[0]
        lrc.append(chosen)
        for e in group:
            if e is not chosen:duplicate_lyrics.append({'duplicate':e['relPath'],'sameAs':chosen['relPath']})
    primary=[];dupes=[]
    for hash_, group in sorted(dedup.items()):
        chosen=sorted(group,key=lambda e:(bool(e['copyNumber']),len(e['name']),e['name']))[0]
        primary.append(chosen)
        for other in group:
            if other is not chosen:dupes.append({'duplicate':other['relPath'],'sameAs':chosen['relPath'],'hash':hash_})
    primary.sort(key=lambda e:e['relPath'].casefold())
    original=[e for e in primary if e['role']!='accompaniment']
    competing_names=defaultdict(list)
    for entry in original: competing_names[entry['key']].append(entry)
    supplied_accomp=[e for e in primary if e['role']=='accompaniment']
    used_lrc:set[str]=set()
    output=[]
    for track in original:
        candidates=[]
        # Only equal full-name keys can be auto-attached; unique title is a
        # weaker proposal, not an automatic match, even when artist overlaps.
        exact=[e for e in lrc if e['key']==track['key']]
        if len(exact)==1:candidates=exact
        elif len(exact)>1:candidates=exact
        else:
            weak=[e for e in lrc if e['titleKey']==track['titleKey'] and e['titleKey']
                  and (not VERSION.search(e['base']) or canonical(e['base'])==track['key'])]
            candidates=weak
        issues=[]
        chosen=None
        if len(exact)==1:chosen=exact[0]
        elif len(exact)>1:issues.append('multiple-lyrics-candidates')
        elif candidates:issues.append('lyrics-needs-confirmation')
        else:issues.append('missing-lyrics')
        if track['probe']['probeState']=='invalid':issues.append('invalid-audio')
        if track['role']=='unmarked':issues.append('audio-role-unmarked-original-assumed')
        title_tag=(track['probe']['tags'].get('title') or '').strip()
        artist_tag=(track['probe']['tags'].get('artist') or '').strip()
        if title_tag and track['artist'] and canonical(title_tag)!=track['titleKey']:
            issues.append('filename-id3-title-conflict')
        if artist_tag and track['artist'] and canonical(artist_tag)!=track['artistKey']:
            issues.append('filename-id3-artist-conflict')
        if track['copyNumber']:issues.append('duplicate-suffix')
        if len(competing_names[track['key']])>1:issues.append('same-title-different-audio-review')
        if any(a['hash']==track['hash'] and a['role']=='accompaniment' for a in audio):
            issues.append('role-conflict-same-audio')
        if chosen:
            used_lrc.add(chosen['path'])
            doc=chosen['lrc']
            if not doc['hasTiming']:issues.append('lyrics-no-timestamps')
            if doc['invalidTags']:issues.append('lyrics-invalid-tags')
            duration=track['probe']['durationMs']
            if duration is not None and doc['maxStartMs'] is not None and doc['maxStartMs']>duration+2000:
                issues.append('lyrics-timestamp-exceeds-audio')
        accompan=[a for a in supplied_accomp if a['key']==track['key']]
        picked_acc=accompan[0] if len(accompan)==1 else None
        if len(accompan)>1:issues.append('multiple-accompaniment-candidates')
        if chosen is None and len(candidates)==1:proposal=candidates[0]['relPath']
        else:proposal=None
        song_id=str(uuid.uuid5(ID_NS,track['hash']))
        status='needs-review' if any(x in issues for x in (
            'multiple-lyrics-candidates','lyrics-needs-confirmation','invalid-audio','lyrics-invalid-tags',
            'lyrics-timestamp-exceeds-audio','multiple-accompaniment-candidates',
            'same-title-different-audio-review','role-conflict-same-audio',
            'filename-id3-title-conflict','filename-id3-artist-conflict')) else 'ready-to-extract'
        output.append({'songId':song_id,'status':status,'title':track['title'], 'artist':track['artist'],
                       'original':track['relPath'],'originalHash':track['hash'],
                       'suppliedAccompaniment':picked_acc['relPath'] if picked_acc else None,
                       'lyrics':chosen['relPath'] if chosen else None,'lyricsProposal':proposal,
                       'timedLyricsCount':len(chosen['lrc']['timedLines']) if chosen else 0,
                       'durationMs':track['probe']['durationMs'],'issues':issues})
    unpaired=[e['relPath'] for e in lrc if e['path'] not in used_lrc]
    orphan_accomp=[e['relPath'] for e in supplied_accomp if not any(e['key']==s['key'] for s in original)]
    return {'schema':'p040.local-ai-import.preflight.v1','mode':'read-only-scan','sourceRoot':str(root),
            'summary':{'audioFiles':len(audio),'originalCandidates':len(original),
                       'lrcFiles':len(lrc),'exactPairs':sum(bool(s['lyrics']) for s in output),
                       'readyToExtract':sum(s['status']=='ready-to-extract' for s in output),
                       'needsReview':sum(s['status']=='needs-review' for s in output),
                       'duplicates':len(dupes),'duplicateLyrics':len(duplicate_lyrics),'unpairedLrc':len(unpaired)},
            'songs':output,'duplicateFiles':dupes,'duplicateLyrics':duplicate_lyrics,'unpairedLrc':unpaired,'orphanAccompaniments':orphan_accomp}


def extraction_plan(songs: list[dict[str,Any]],root: Path,output: Path,model: str) -> list[dict[str,Any]]:
    tasks=[]
    for song in songs:
        if song['status']!='ready-to-extract' or song['suppliedAccompaniment']:continue
        dest=output/song['songId']
        cmd=['audio-separator',str(root/song['original']),'--model_filename',model,
             '--output_dir',str(dest),'--output_format','FLAC','--single_stem','Instrumental',
             '--custom_output_names',json.dumps({'Instrumental':'accompaniment'})]
        tasks.append({'songId':song['songId'],'title':song['title'],'command':cmd,
                      'expectedOutput':str(dest/'accompaniment.flac'),'input':str(root/song['original'])})
    return tasks


def main(argv=None):
    parser=argparse.ArgumentParser(description='P040 safe MP3/LRC matcher and local accompaniment extraction task planner')
    parser.add_argument('folder',help='Folder with owner-provided MP3 and LRC files')
    parser.add_argument('--report',type=Path,default=Path('import-preview.json'),help='Write local JSON scan report (outside input folder)')
    parser.add_argument('--tasks',type=Path,help='Optional extraction job plan JSON')
    parser.add_argument('--output',type=Path,help='Separated media output root (required with --tasks)')
    parser.add_argument('--model',default='model_bs_roformer_ep_317_sdr_12.9755.yaml')
    args=parser.parse_args(argv)
    root=Path(args.folder).expanduser().resolve(strict=True)
    report=args.report.expanduser().resolve()
    if report.is_relative_to(root):parser.error('--report must be outside the music input folder')
    result=scan(root)
    report.parent.mkdir(parents=True,exist_ok=True)
    report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if args.tasks:
        if not args.output:parser.error('--tasks requires --output')
        output=args.output.expanduser().resolve()
        if output.is_relative_to(root):parser.error('--output must be outside the music input folder')
        tasks=extraction_plan(result['songs'],root,output,args.model)
        tasks_path=args.tasks.expanduser().resolve()
        if tasks_path.is_relative_to(root):parser.error('--tasks must be outside the music input folder')
        tasks_path.parent.mkdir(parents=True,exist_ok=True)
        tasks_path.write_text(json.dumps({'tasks':tasks,'note':'Commands are NOT executed; model must be installed and preflighted on Mac mini before running.'},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result['summary'],ensure_ascii=False,indent=2))
    return 0

if __name__=='__main__':raise SystemExit(main())
