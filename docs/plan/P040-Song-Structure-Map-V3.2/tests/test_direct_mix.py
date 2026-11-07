import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import soundfile as sf
from sys import path
path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from direct_mix_similarity import calculate_similarity


class DirectMixTests(unittest.TestCase):
    def test_original_audio_only_produces_suggestions(self):
        with tempfile.TemporaryDirectory() as t:
            sr=22050
            ts=np.arange(sr*6,dtype=float)/sr
            # Original synthesized signal: three 6-second sections, A and A identical.
            # Not a user's copyrighted recording. No separation done.
            a=np.sin(2*np.pi*220*ts)+0.5*np.sin(2*np.pi*330*ts)
            b=np.sin(2*np.pi*247*ts)+0.5*np.sin(2*np.pi*370*ts)
            y=np.concatenate([a,b,a]).astype('float32')*0.25
            root=Path(t)
            audio=root/'original-mix.wav';sf.write(audio,y,sr)
            model={'segments':[{'start':0,'end':6,'label':'verse'},{'start':6,'end':12,'label':'bridge'},{'start':12,'end':18,'label':'verse'}]}
            before=audio.read_bytes()
            result=calculate_similarity(audio,model)
            self.assertEqual(result['origin'],'original-mix-only')
            self.assertEqual(len(result['audioEvidence']),1)
            self.assertEqual((result['audioEvidence'][0]['left'],result['audioEvidence'][0]['right']),(0,2))
            self.assertEqual(result['audioEvidence'][0]['status'],'pending-confirmation')
            self.assertEqual(audio.read_bytes(),before)

if __name__=='__main__':unittest.main()
