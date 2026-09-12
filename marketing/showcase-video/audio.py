import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile
SR=48000; DUR=26.6; N=int(SR*DUR); buf=np.zeros((N,2)); rng=np.random.default_rng(3)
def sos(kind,lo,hi=None,order=4):
    if kind=='bp': return butter(order,[lo,hi],btype='band',fs=SR,output='sos')
    if kind=='lp': return butter(order,lo,btype='low',fs=SR,output='sos')
    return butter(order,lo,btype='high',fs=SR,output='sos')
def env_ad(n,att,dec,curve=3.0):
    t=np.arange(n)/SR; a=np.clip(t/att,0,1) if att>0 else np.ones(n); return a*np.exp(-curve*np.clip((t-att)/max(dec,1e-4),0,None))
def env_swell(n,att,rel):
    t=np.arange(n)/SR; total=n/SR; return (np.clip(t/att,0,1)**2)*(np.clip((total-t)/rel,0,1)**2)
def sine(f,dur,f_end=None):
    n=int(SR*dur); t=np.arange(n)/SR
    if f_end is None: return np.sin(2*np.pi*f*t)
    fr=f+(f_end-f)*(t/dur); return np.sin(2*np.pi*np.cumsum(fr)/SR)
def noise(dur): return rng.standard_normal(int(SR*dur))
def place(t,sig,g=1.0,pan=0.0):
    i=int(t*SR); n=min(len(sig),N-i)
    if n<=0: return
    l=g*np.sqrt(0.5*(1-pan))*1.414; r=g*np.sqrt(0.5*(1+pan))*1.414
    if sig.ndim==2: buf[i:i+n,0]+=sig[:n,0]*g; buf[i:i+n,1]+=sig[:n,1]*g
    else: buf[i:i+n,0]+=sig[:n]*l; buf[i:i+n,1]+=sig[:n]*r
def whoosh(dur,lo,hi,att=0.08,g=1.0,sweep=None):
    n=noise(dur)
    if sweep:
        segs=6; out=np.zeros_like(n); L=len(n)//segs
        for k in range(segs):
            f0=lo*(hi/lo)**(k/(segs-1)) if sweep=='up' else hi*(lo/hi)**(k/(segs-1))
            s=sosfilt(sos('bp',f0*0.6,f0*1.6),n); seg=slice(k*L,(k+1)*L if k<segs-1 else len(n)); out[seg]=s[seg]
        n=sosfilt(sos('lp',12000),out)
    else: n=sosfilt(sos('bp',lo,hi),n)
    return n*env_ad(len(n),att,dur-att,4.0)*g
def padd(a,b):
    n=max(len(a),len(b)); out=np.zeros(n); out[:len(a)]+=a; out[:len(b)]+=b; return out
def click(g=1.0):
    a=sine(1500,0.014)*env_ad(int(SR*0.014),0.001,0.01,5); b=0.6*sosfilt(sos('bp',1500,7000),noise(0.008))*env_ad(int(SR*0.008),0.0005,0.006,5); return padd(a,b)*g
def pop(f,g=1.0,dur=0.09):
    s=sine(f*1.35,dur,f)*env_ad(int(SR*dur),0.003,dur-0.003,5); s+=0.25*sosfilt(sos('bp',800,4000),noise(dur))*env_ad(int(SR*dur),0.001,0.02,6); return s*g
def tone(f,dur,g=1.0,att=0.01,dec=None):
    n=int(SR*dur); s=sine(f,dur)+0.35*sine(2*f,dur)+0.12*sine(3*f,dur); return s*env_ad(n,att,(dec or dur-att),3.5)*g/1.47
def thud(f0,f1,dur,g=1.0): return sine(f0,dur,f1)*env_ad(int(SR*dur),0.004,dur-0.004,4.5)*g
def load(path):
    sr,d=wavfile.read(path); d=d.astype(np.float64)/32768.0
    if d.ndim==1: d=np.stack([d,d],1)
    assert sr==SR, (path,sr); return d
# ---- pad bed (whole)
n=int(SR*DUR); t=np.arange(n)/SR
pad=(sine(55,DUR)*0.9+sine(82.41,DUR)*0.5+sine(110,DUR)*0.45+sine(164.8,DUR)*0.25+sine(220.4,DUR)*0.12)*(0.8+0.2*np.sin(2*np.pi*0.13*t))
pad=sosfilt(sos('lp',260,2),pad)*env_swell(n,2.0,1.5); place(0.0,pad,0.05)
air=sosfilt(sos('lp',500,2),noise(DUR))*env_swell(n,2.5,1.5); place(0.0,air,0.010)
# ---- intro icon
place(0.10,whoosh(0.7,200,1800,0.2,1.0,'up'),0.14); place(0.40,pop(330,1.0,0.14),0.26)
# phone rise + taps + transitions
place(2.6,whoosh(0.8,150,900,0.3,1.0),0.16)
for tt in (4.5,6.1,7.9,14.3,17.1,19.3): place(tt,click(),0.42)
for tt in (4.9,6.4,8.3,14.65): place(tt,whoosh(0.3,1200,7000,0.03,1.0,'up'),0.12)
# scan 8.6-11.0, completion chime 11.15
sw=sine(320,2.4,1150)*env_swell(int(SR*2.4),0.5,0.5); place(8.6,sosfilt(sos('lp',2500),sw),0.05)
sh=sosfilt(sos('bp',3000,9000),noise(2.4))*env_swell(int(SR*2.4),0.6,0.4); place(8.6,sh,0.035)
place(11.15,tone(880,0.5,0.22,0.008,0.4)); place(11.27,tone(1318.5,0.7,0.2,0.008,0.55))
# score: transition + ring riser + chord
place(11.85,whoosh(0.5,300,2500,0.06,1.0,'down'),0.12)
for k,f in enumerate((523.25,659.25,783.99,1046.5)): place(12.1+k*0.22,tone(f,0.5,0.15,0.006,0.4),pan=-0.2+0.13*k)
for f in (523.25,659.25,783.99,1046.5): place(13.05,tone(f,1.4,0.10,0.02,1.2))
# problem card rise; drills: phone out, chips, card pops, save
place(14.9,pop(300,1.0,0.12),0.22)
place(17.45,whoosh(0.5,600,4000,0.06,1.0,'down'),0.12)
for k,f in enumerate((520,600,690)): place(17.7+k*0.2,pop(f),0.24,pan=0.15)
place(19.55,tone(1318.5,0.3,0.12,0.005,0.25))
# outro
place(20.4,whoosh(0.6,1500,6000,0.05,1.0,'down'),0.12); place(20.75,pop(300,1.0,0.16),0.24)
place(23.0,pop(420,1.0,0.12),0.2); place(23.1,tone(1760,0.5,0.05,0.02,0.4))
# swing ambience under the scan (very low)
amb=load('swing_audio.wav'); amb=amb*env_swell(len(amb),0.4,0.6)[:,None]; place(8.4,amb,9.0)
# voiceover
VO={1:0.5,2:3.3,3:5.3,4:6.8,5:8.9,6:12.3,8:15.0,9:18.1,7:21.1,10:23.2}
for i,at in VO.items():
    v=load(f'vo/vo{i}.wav'); peak=np.abs(v).max(); place(at,v/peak,0.62)
buf=np.tanh(buf*1.15)/np.tanh(1.15); peak=np.abs(buf).max(); buf*=0.92/peak
fade=int(SR*0.5); buf[-fade:]*=np.linspace(1,0,fade)[:,None]
wavfile.write('audio.wav',SR,(buf*32767).astype(np.int16))
print('audio.wav ok peak',round(peak,3),'rms dBFS',round(20*np.log10(np.sqrt(np.mean(buf**2))),1))
