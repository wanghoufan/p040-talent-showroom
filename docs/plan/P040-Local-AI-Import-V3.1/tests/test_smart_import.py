import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tool'))
from p040_smart_import import (canonical,strip_copy_num,audio_role,name_identity,parse_lrc,list_source_files,scan,extraction_plan)

class PureTests(unittest.TestCase):
 def test_comma_and_whitespace(self):
  self.assertEqual(canonical('3LAU, Carly Paige - Touch'),canonical('3LAU,Carly Paige - Touch'))
 def test_unicode_nfk(self):
  self.assertEqual(canonical('ＡＢＣ， Ｄｅｆ - Test'),canonical('ABC,Def - test'))
 def test_copy_suffix_removed(self):
  self.assertEqual(strip_copy_num('宝石Gem - 爱的恰恰 (1)'),'宝石Gem - 爱的恰恰')
 def test_version_not_discarded(self):
  self.assertNotEqual(name_identity('Song (8D Audio).mp3')['key'],name_identity('Song.mp3')['key'])
 def test_song_and_artist(self):
  self.assertEqual(name_identity('4MINUTE - 미쳐.mp3')['title'],'미쳐')
 def test_role_instrumental(self):
  self.assertEqual(audio_role('Artist - Song (伴奏)')[1],'accompaniment')
 def test_role_original(self):
  self.assertEqual(audio_role('Artist - Song - 原唱')[1],'original')
 def test_role_with_copy_suffix(self):
  self.assertEqual(name_identity('Artist - Song - 伴奏 (1).mp3')['role'],'accompaniment')
 def test_role_unknown(self):
  self.assertEqual(audio_role('Artist - Song')[1],'unmarked')
 def test_lrc_multitag_and_bom(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'s.lrc';p.write_text('\ufeff[ar:Singer]\n[offset:120]\n[00:01.23][00:12.300]你好\n[00:15.2]世界\n')
   r=parse_lrc(p)
   self.assertEqual([t['startMs'] for t in r['timedLines']],[1350,12420,15200+120])
   self.assertTrue(r['hasTiming'])
 def test_lrc_bad_timestamp(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'s.lrc';p.write_text('[00:62.12]wrong\n')
   self.assertEqual(parse_lrc(p)['invalidTags'],1)
 def test_unsynced(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'s.lrc';p.write_text('hello\n你好\n')
   self.assertFalse(parse_lrc(p)['hasTiming'])
 def test_no_overwrite_input(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'music';root.mkdir();p=root/'x.mp3';p.write_text('not real audio')
   before=p.read_bytes();res=scan(root)
   self.assertEqual(p.read_bytes(),before)
   self.assertEqual(res['summary']['originalCandidates'],1)
 def test_symlink_ignored(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'music';root.mkdir();outside=Path(d)/'outside.mp3';outside.write_text('x')
   (root/'leak.mp3').symlink_to(outside)
   self.assertEqual(list_source_files(root),[])

class ScannerTests(unittest.TestCase):
 def setUp(self):
  self.d=tempfile.TemporaryDirectory();self.root=Path(self.d.name)/'music';self.root.mkdir()
 def tearDown(self):self.d.cleanup()
 def fake(self,name,content=None):
  p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True)
  p.write_bytes((content or name).encode('utf-8'));return p
 def make_real_audio(self,name,duration=2):
  target=self.root/name
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration='+str(duration),
                  '-ac','1','-b:a','96k',str(target)],check=True,capture_output=True,timeout=15)
  return target
 def test_precise_matching(self):
  self.make_real_audio('3LAU, Carly Paige - Touch.mp3')
  self.fake('3LAU,Carly Paige - Touch.lrc','[00:00.20]hello\n')
  r=scan(self.root)
  self.assertEqual(r['summary']['exactPairs'],1)
  self.assertEqual(r['songs'][0]['status'],'ready-to-extract')
 def test_korean_match(self):
  self.make_real_audio('4MINUTE - 미쳐.mp3');self.fake('4MINUTE - 미쳐.lrc','[00:01.2]안녕\n')
  self.assertEqual(scan(self.root)['summary']['exactPairs'],1)
 def test_chinese_copy_suffix(self):
  self.make_real_audio('宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰 (1).mp3')
  self.fake('宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰.lrc','[00:01.0]你好\n')
  self.assertEqual(scan(self.root)['summary']['exactPairs'],1)
 def test_duplicate_same_bytes(self):
  a=self.make_real_audio('A - B.mp3');(self.root/'A - B (1).mp3').write_bytes(a.read_bytes())
  self.assertEqual(scan(self.root)['summary']['duplicates'],1)
  self.assertEqual(scan(self.root)['summary']['originalCandidates'],1)
 def test_same_name_different_bytes_no_merge(self):
  self.make_real_audio('A - B.mp3',1)
  self.make_real_audio('A - B (1).mp3',2)
  r=scan(self.root)
  self.assertEqual(r['summary']['originalCandidates'],2)
  self.assertTrue(all('same-title-different-audio-review' in x['issues'] for x in r['songs']))
 def test_variants_never_cross_match(self):
  self.make_real_audio('Artist - Song (8D Audio).mp3')
  self.fake('Artist - Song.lrc','[00:00.50]song\n')
  r=scan(self.root)
  self.assertEqual(r['summary']['exactPairs'],0)
 def test_identical_lrc_copies_auto_dedup(self):
  self.make_real_audio('Artist - Song.mp3')
  a=self.fake('Artist - Song.lrc','[00:00.50]a\n')
  (self.root/'Artist - Song (1).lrc').write_bytes(a.read_bytes())
  r=scan(self.root)
  self.assertEqual(r['summary']['duplicateLyrics'],1)
  self.assertEqual(r['summary']['exactPairs'],1)
 def test_multiple_lrc_does_not_pick_one(self):
  self.make_real_audio('Artist - Song.mp3')
  self.fake('Artist - Song.lrc','[00:00.50]a\n')
  self.fake('Artist - Song (1).lrc','[00:00.50]b\n')
  r=scan(self.root)
  self.assertIsNone(r['songs'][0]['lyrics']);self.assertIn('multiple-lyrics-candidates',r['songs'][0]['issues'])
 def test_weak_match_needs_review(self):
  self.make_real_audio('88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3')
  self.fake('88rising,Joji,Rich Brian - Midsummer Madness.lrc','[00:00.1]hi\n')
  r=scan(self.root)
  self.assertEqual(r['summary']['exactPairs'],0)
  self.assertEqual(r['songs'][0]['status'],'needs-review')
  self.assertIsNotNone(r['songs'][0]['lyricsProposal'])
 def test_lyrics_ahead_duration(self):
  self.make_real_audio('Artist - Song.mp3',1)
  self.fake('Artist - Song.lrc','[02:00.0]very late\n')
  r=scan(self.root)
  self.assertIn('lyrics-timestamp-exceeds-audio',r['songs'][0]['issues'])
 def test_accompaniment_identified(self):
  self.make_real_audio('Singer - Song.mp3')
  a=self.root/'Singer - Song - 伴奏.mp3'
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=550:duration=2','-b:a','96k',str(a)],check=True,capture_output=True)
  r=scan(self.root)
  self.assertEqual(r['summary']['originalCandidates'],1)
  self.assertEqual(r['songs'][0]['suppliedAccompaniment'],'Singer - Song - 伴奏.mp3')
 def test_tasks_are_plan_only(self):
  self.make_real_audio('Singer - Song.mp3')
  r=scan(self.root)
  tasks=extraction_plan(r['songs'],self.root,Path(self.d.name)/'output','model.yaml')
  self.assertEqual(len(tasks),1)
  self.assertIn('--single_stem',tasks[0]['command'])
  self.assertEqual(tasks[0]['input'],str(self.root/'Singer - Song.mp3'))
  plan=Path(self.d.name)/'plan.json';plan.write_text(json.dumps({'tasks':tasks}))
  self.assertEqual(run_jobs(plan)['results'][0]['status'],'dry-run')
  self.assertFalse((Path(self.d.name)/'output').exists())
 def test_cli_rejects_write_to_source(self):
  self.make_real_audio('Singer - Song.mp3')
  p=subprocess.run([sys.executable,str(ROOT/'tool/p040_smart_import.py'),str(self.root),'--report',str(self.root/'report.json')],capture_output=True,text=True)
  self.assertNotEqual(p.returncode,0)
  self.assertFalse((self.root/'report.json').exists())

if __name__=='__main__':unittest.main()

# Further regression tests for extraction runner (no model or network installed).
from run_separation import run_jobs
class RunnerTests(unittest.TestCase):
 def test_runner_dry_run_does_not_execute(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);src=base/'a.mp3';src.write_bytes(b'test')
   job={'songId':'s','input':str(src),'expectedOutput':str(base/'out'/'a.flac'),
        'command':['audio-separator',str(src),'--model_filename','x','--output_dir',str(base/'out'),'--output_format','FLAC']}
   task=base/'tasks.json';task.write_text(json.dumps({'tasks':[job]}))
   result=run_jobs(task)
   self.assertEqual(result['results'][0]['status'],'dry-run')
   self.assertFalse((base/'out').exists())
 def test_runner_invalid_command_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);src=base/'a.mp3';src.write_bytes(b'test')
   task=base/'tasks.json';task.write_text(json.dumps({'tasks':[{'songId':'s','input':str(src),'expectedOutput':str(base/'b.flac'),'command':['rm','-rf','/']}]}))
   with self.assertRaises(ValueError):run_jobs(task)
 def test_runner_skips_existing_output(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);src=base/'a.mp3';src.write_bytes(b'test')
   dest=base/'out'/'a.flac';dest.parent.mkdir();dest.write_text('existing')
   task=base/'tasks.json';task.write_text(json.dumps({'tasks':[{'songId':'s','input':str(src),'expectedOutput':str(dest),'command':['audio-separator',str(src),'--model_filename','x','--output_dir',str(base/'out'),'--output_format','FLAC']}]}))
   self.assertEqual(run_jobs(task)['results'][0]['status'],'skipped-output-exists')
   self.assertEqual(dest.read_text(),'existing')

class RunnerSafetyTests(unittest.TestCase):
 def test_output_redirection_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);src=base/'input.mp3';src.write_bytes(b'original')
   task=base/'tasks.json'
   task.write_text(json.dumps({'tasks':[{'songId':'s','input':str(src),'expectedOutput':str(base/'safe'/'accompaniment.flac'),
            'command':['audio-separator',str(src),'--model_filename','x','--output_dir',str(base),'--output_format','FLAC']}]}))
   with self.assertRaisesRegex(ValueError,'output_dir'):run_jobs(task)
   self.assertEqual(src.read_bytes(),b'original')
