import re
p='diep-assist.user.js'
s=open(p,encoding='utf-8').read()
pred=open('bench/predictors/adaptive.mjs',encoding='utf-8').read().replace('export function createPredictor','function createPredictor')
pred='\n'.join(('  '+l if l.strip() else l) for l in pred.rstrip('\n').split('\n'))
a=s.index("  /* ===================================================================== *\n   *  5a. Per-target predictor")
b=s.index("  // a track that turns out to be a different tank")
head='''  /* ===================================================================== *
   *  5a. Per-target predictor: constant velocity + learned strafing rhythm + learned dodging
   *      (source of truth: bench/predictors/adaptive.mjs, benchmarked with bench/run.mjs)
   * ===================================================================== */
'''
s=s[:a]+head+pred+'\n\n'+s[b:]
open(p,'w',encoding='utf-8').write(s)
