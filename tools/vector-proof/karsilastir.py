# Kullanım: karsilastir.py <orijinal> <vektör-render(aynı boyut)> <çıktı-önek>
import sys; from PIL import Image; import math
o=Image.open(sys.argv[1]).convert('RGBA'); v=Image.open(sys.argv[2]).convert('RGBA').resize(o.size, Image.LANCZOS)
w,h=o.size; op=o.load(); vp=v.load()
def lab(r,g,b):
    f=lambda c: (c/255/12.92 if c/255<=0.04045 else ((c/255+0.055)/1.055)**2.4)
    R,G,B=f(r),f(g),f(b); t=lambda x: x**(1/3) if x>0.008856 else 7.787*x+16/116
    X=t((R*0.4124+G*0.3576+B*0.1805)/0.95047); Y=t(R*0.2126+G*0.7152+B*0.0722); Z=t((R*0.0193+G*0.1192+B*0.9505)/1.08883)
    return 116*Y-16,500*(X-Y),200*(Y-Z)
heat=Image.new('RGBA',(w,h),(235,235,235,255)); hp=heat.load()
n=0; s=0; big=0; mid=0; shape=0
for y in range(h):
    for x in range(w):
        a=op[x,y][3]>127; b=vp[x,y][3]>127
        if a!=b: shape+=1; hp[x,y]=(60,60,200,255); continue
        if not a: hp[x,y]=(255,255,255,255); continue
        p=lab(*op[x,y][:3]); q=lab(*vp[x,y][:3]); d=math.dist(p,q); n+=1; s+=d
        if d>6: big+=1; hp[x,y]=(200,30,30,255)
        elif d>2.3: mid+=1; hp[x,y]=(240,170,170,255)
        else: hp[x,y]=(200,200,200,255)
print(f"ortalama ΔE={s/n:.2f}  belirgin fark (ΔE>6): {100*big/n:.1f}%  hafif (2.3–6): {100*mid/n:.1f}%  şekil farkı: {shape} px")
k=4
sheet=Image.new('RGBA',(w*k*3+20,h*k),(255,255,255,255))
for i,im in enumerate([o,v,heat]): sheet.alpha_composite(im.resize((w*k,h*k),Image.NEAREST if i==2 else Image.LANCZOS),(i*(w*k+10),0))
sheet.save(sys.argv[3]+'-genis.png')
