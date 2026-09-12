import numpy as np, sys
from scipy.signal import butter, sosfilt
from scipy.io import wavfile
SR=48000; DUR=41.0
N=int(SR*DUR); buf=np.zeros((N,2),dtype=np.float64)
rng=np.random.default_rng(7)
def sos(kind,lo,hi=None,order=4):
    if kind=='bp': return butter(order,[lo,hi],btype='band',fs=SR,output='sos')
    if kind=='lp': return butter(order,lo,btype='low',fs=SR,output='sos')
    if kind=='hp': return butter(order,lo,btype='high',fs=SR,output='sos')
def env_ad(n,att,dec,curve=3.0):
    t=np.arange(n)/SR; a=np.clip(t/att,0,1) if att>0 else np.ones(n)
    d=np.exp(-curve*np.clip((t-att)/max(dec,1e-4),0,None)); return a*d
def env_swell(n,att,rel):
    t=np.arange(n)/SR; total=n/SR
    a=np.clip(t/att,0,1)**2; r=np.clip((total-t)/rel,0,1)**2; return a*r
def sine(f,dur,f_end=None):
    n=int(SR*dur); t=np.arange(n)/SR
    if f_end is None: return np.sin(2*np.pi*f*t)
    fr=f+(f_end-f)*(t/dur); ph=2*np.pi*np.cumsum(fr)/SR; return np.sin(ph)
def noise(dur): return rng.standard_normal(int(SR*dur))
def place(t,sig,g=1.0,pan=0.0):
    i=int(t*SR); n=min(len(sig),N-i)
    if n<=0: return
    l=g*(1-max(pan,0)); r=g*(1+min(pan,0)) if pan<0 else g
    l=g*np.sqrt(0.5*(1-pan)); r=g*np.sqrt(0.5*(1+pan))
    buf[i:i+n,0]+=sig[:n]*l*1.414; buf[i:i+n,1]+=sig[:n]*r*1.414
def whoosh(dur,lo,hi,att=0.08,g=1.0,sweep=None):
    n=noise(dur)
    if sweep:  # split into segments with moving bandpass
        segs=6; out=np.zeros_like(n); L=len(n)//segs
        for k in range(segs):
            f0=lo*(hi/lo)**(k/(segs-1)) if sweep=='up' else hi*(lo/hi)**(k/(segs-1))
            s=sosfilt(sos('bp',f0*0.6,f0*1.6),n); seg=slice(k*L,(k+1)*L if k<segs-1 else len(n))
            out[seg]=s[seg]
        n=sosfilt(sos('lp',12000),out)
    else: n=sosfilt(sos('bp',lo,hi),n)
    return n*env_ad(len(n),att,dur-att,4.0)*g
def padd(a,b):
    n=max(len(a),len(b)); out=np.zeros(n); out[:len(a)]+=a; out[:len(b)]+=b; return out
def click(g=1.0):
    a=sine(1500,0.014)*env_ad(int(SR*0.014),0.001,0.01,5)
    b=0.6*sosfilt(sos('bp',1500,7000),noise(0.008))*env_ad(int(SR*0.008),0.0005,0.006,5)
    return padd(a,b)*g
def pop(f,g=1.0,dur=0.09):
    s=sine(f*1.35,dur,f)*env_ad(int(SR*dur),0.003,dur-0.003,5)
    s+=0.25*sosfilt(sos('bp',800,4000),noise(dur))*env_ad(int(SR*dur),0.001,0.02,6)
    return s*g
def tone(f,dur,g=1.0,att=0.01,dec=None):
    n=int(SR*dur); s=sine(f,dur)+0.35*sine(2*f,dur)+0.12*sine(3*f,dur)
    return s*env_ad(n,att,(dec or dur-att),3.5)*g/1.47
def thud(f0,f1,dur,g=1.0):
    return sine(f0,dur,f1)*env_ad(int(SR*dur),0.004,dur-0.004,4.5)*g
# ---- pad bed (0-37) very quiet, warm
n=int(SR*38.0); t=np.arange(n)/SR
pad=(sine(55,38.0)*0.9+sine(82.41,38.0)*0.5+sine(110,38.0)*0.45+sine(164.8,38.0)*0.25+sine(220.0*1.002,38.0)*0.12)
pad*= (0.8+0.2*np.sin(2*np.pi*0.13*t))*(0.85+0.15*np.sin(2*np.pi*0.071*t+1))
pad=sosfilt(sos('lp',260,2),pad)
padenv=env_swell(n,2.5,1.2); place(0.0,pad*padenv,0.055)
air=sosfilt(sos('lp',500,2),noise(38.0))*env_swell(n,3.0,1.5); place(0.0,air,0.012)
# ---- intro
place(0.85,whoosh(0.6,500,4500,0.12,1.0,'down'),0.32,pan=0.35)
place(1.32,thud(85,42,0.35),0.5); place(1.32,sosfilt(sos('bp',1000,6000),noise(0.03))*env_ad(int(SR*0.03),0.001,0.02,5),0.25)
place(1.75,tone(1760,0.25,0.06,0.004,0.2))
place(2.05,tone(2637,0.2,0.04,0.004,0.16))
# phone rise
place(3.9,whoosh(0.9,150,900,0.35,1.0),0.16)
# taps + transitions
for tt in (6.55,8.55,9.85): place(tt,click(),0.42)
for tt in (7.1,10.5): place(tt,whoosh(0.32,1200,7000,0.03,1.0,'up'),0.13)
place(8.85,whoosh(0.35,300,1800,0.05,1.0,'up'),0.12)
# capture: detection chime at 12.8, saved tick 13.7
place(12.8,tone(880,0.55,0.26,0.008,0.45)); place(12.92,tone(1318.5,0.7,0.24,0.008,0.6))
place(13.7,click(),0.25); place(13.7,tone(1568,0.3,0.08,0.005,0.25))
# checks: card pops rising, done chime
for k,f in enumerate((520,585,655,735,825)): place(16.7+k*0.45,pop(f),0.3,pan=0.3)
place(19.3,tone(1046.5,0.5,0.22,0.01,0.4)); place(19.42,tone(1318.5,0.7,0.2,0.01,0.55))
# score reveal
place(20.9,whoosh(1.1,2000,9000,0.7,1.0),0.09)
for k,f in enumerate((523.25,659.25,783.99,1046.5)): place(21.55+k*0.22,tone(f,0.5,0.17,0.006,0.4),pan=-0.2+0.13*k)
for f in (523.25,659.25,783.99,1046.5): place(22.45,tone(f,1.6,0.11,0.02,1.4))
# priority + delta
place(25.8,whoosh(0.4,300,2500,0.05,1.0,'down'),0.1)
place(26.4,pop(300,1.0,0.12),0.28); place(27.6,pop(720),0.3,pan=0.3); place(27.95,tone(1318.5,0.35,0.1,0.005,0.3),pan=0.3)
# drills
place(31.0,whoosh(0.5,600,5000,0.06,1.0,'down'),0.18,pan=0.4); place(31.55,thud(120,70,0.2),0.18)
place(32.55,tone(1760,0.25,0.07,0.004,0.2))
# outro slash + black
place(36.95,whoosh(0.42,1500,10000,0.04,1.0,'down'),0.55,pan=-0.3)
place(37.0,tone(3200,0.3,0.08,0.002,0.25))
place(37.8,thud(60,32,0.7),0.75); place(37.8,sosfilt(sos('lp',900),noise(0.12))*env_ad(int(SR*0.12),0.002,0.09,5),0.35)
# end chord swell 38.4 -> end
n=int(SR*(DUR-38.4)); t=np.arange(n)/SR
chord=(sine(110,DUR-38.4)*0.8+sine(164.81,DUR-38.4)*0.5+sine(220,DUR-38.4)*0.5+sine(329.63,DUR-38.4)*0.28+sine(440,DUR-38.4)*0.12)
chord=sosfilt(sos('lp',700,2),chord)*env_swell(n,1.6,1.0); place(38.4,chord,0.11)
place(38.65,tone(1760,0.6,0.06,0.02,0.5)); place(39.5,tone(2217.5,0.6,0.05,0.02,0.5))
# master
buf=np.tanh(buf*1.2)/np.tanh(1.2); peak=np.abs(buf).max(); buf*=0.89/peak
# gentle fade at very end
fade=int(SR*0.4); buf[-fade:]*=np.linspace(1,0,fade)[:,None]
wavfile.write('audio.wav',SR,(buf*32767).astype(np.int16))
rms=20*np.log10(np.sqrt(np.mean(buf**2))+1e-9); print('wrote audio.wav peak',peak,'rms dBFS',round(rms,1))
