import tempfile, unittest, shutil, sys
from pathlib import Path

BASE=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(BASE/'tool'))
from verify_real_samples import audit, normalize

FIXTURE=BASE/'examples'/'sample_inputs'

class RealSamplesAuditTests(unittest.TestCase):
    def test_normalizes_comma_spacing_and_korean(self):
        self.assertEqual(normalize('3LAU, Carly Paige - Touch.mp3'),normalize('3LAU,Carly Paige - Touch.mp3'))
        self.assertEqual(normalize('4MINUTE - 미쳐.mp3'),normalize('4MINUTE - 미쳐.mp3'))

    def test_real_spec_finds_existing_fixture_and_flags_other_missing(self):
        spec={'samples':[
            {'id':'T01','scenario':'comma','audio':['3LAU, Carly Paige - Touch.mp3'],'lyrics':['3LAU,Carly Paige - Touch.lrc'],'expected':'auto-pair-if-valid'},
            {'id':'T02','scenario':'missing','audio':['nonexistent.mp3'],'lyrics':['nonexistent.lrc'],'expected':'auto-pair-if-valid'}]}
        result=audit(FIXTURE,spec)
        self.assertTrue(result['sourceAccessible'])
        self.assertEqual(result['summary']['sampleGroups'],2)
        self.assertEqual(result['samples'][0]['files'][0]['state'],'found')
        self.assertEqual(result['samples'][0]['files'][1]['state'],'found')
        self.assertEqual(result['samples'][1]['state'],'missing-files')

    def test_multi_artist_mismatch_cannot_be_automatically_accepted(self):
        spec={'samples':[{'id':'T07','scenario':'different artists','audio':['88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3'],
                          'lyrics':['88rising,Joji,Rich Brian - Midsummer Madness.lrc'],'expected':'needs-review'}]}
        result=audit(FIXTURE,spec)
        self.assertEqual(result['samples'][0]['state'],'needs-review')
        self.assertIn('explicit-artist-list-conflict',result['samples'][0]['issues'])

    def test_missing_external_volume_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as dir_:
            bad=Path(dir_)/'not-mounted'
            r=audit(bad,{'samples':[]})
            self.assertFalse(r['sourceAccessible'])
            self.assertFalse(bad.exists())

    def test_duplicate_audio_is_not_silently_merged(self):
        with tempfile.TemporaryDirectory() as dir_:
            root=Path(dir_)
            for dest in ['宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰.mp3','宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰 (1).mp3']:
                shutil.copyfile(FIXTURE/'3LAU, Carly Paige - Touch.mp3',root/dest)
            spec={'samples':[{'id':'T05','scenario':'dup','audio':['宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰.mp3','宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰 (1).mp3'],'lyrics':[],'expected':'duplicate-check'}]}
            r=audit(root,spec)
            self.assertEqual(r['samples'][0]['duplicateAudioState'],'byte-identical')
            self.assertEqual(r['samples'][0]['state'],'needs-review')
            (root/'宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰 (1).mp3').write_bytes(b'another version')
            r2=audit(root,spec)
            self.assertEqual(r2['samples'][0]['duplicateAudioState'],'same-title-different-audio-review')
            self.assertIn('do-not-merge-audio',r2['samples'][0]['issues'])

if __name__=='__main__':unittest.main()
