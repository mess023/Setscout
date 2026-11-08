"""BPM + key of one audio file via Essentia. Prints {"bpm": 124.0, "key": "A minor"}."""
import json, sys
import essentia.standard as es

audio = es.MonoLoader(filename=sys.argv[1], sampleRate=44100)()
bpm = es.RhythmExtractor2013(method="multifeature")(audio)[0]
key, scale, _strength = es.KeyExtractor(profileType="edma")(audio)
print(json.dumps({"bpm": round(float(bpm), 1), "key": f"{key} {scale}"}))
