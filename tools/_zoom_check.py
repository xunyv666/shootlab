import sys, json, argparse
import cv2, numpy as np

CONN=[(11,12),(11,13),(13,15),(12,14),(14,16),(11,23),(12,24),(23,24),
      (23,25),(25,27),(24,26),(26,28),(27,29),(29,31),(28,30),(30,32),(0,11),(0,12)]

ap=argparse.ArgumentParser()
ap.add_argument('video'); ap.add_argument('pose'); ap.add_argument('out')
ap.add_argument('--at',default=''); ap.add_argument('--h',type=int,default=300)
a=ap.parse_args()

d=json.load(open(a.pose,encoding='utf-8')); meta=d['meta']
W,H=meta['w'],meta['h']
fr=[f for f in d['frames'] if f.get('pts')]
times=[float(x) for x in a.at.split(',') if x]
cap=cv2.VideoCapture(a.video); fps=cap.get(cv2.CAP_PROP_FPS) or 30

tiles=[]
for t in times:
    f=min(fr,key=lambda x:abs(x['t']-t))
    cap.set(cv2.CAP_PROP_POS_FRAMES,int(round(f['t']*fps)))
    ok,img=cap.read()
    if not ok: continue
    p=f['pts']
    xs=[q[0] for q in p if q[3]>0.2]; ys=[q[1] for q in p if q[3]>0.2]
    if not xs: continue
    x0,x1=min(xs),max(xs); y0,y1=min(ys),max(ys)
    bw,bh=x1-x0,y1-y0
    cx,cy=(x0+x1)/2,(y0+y1)/2
    half=max(bh*0.75,bw*0.75)
    X0=int(max(0,(cx-half)*W)); X1=int(min(W,(cx+half)*W))
    Y0=int(max(0,(cy-half*0.95)*H)); Y1=int(min(H,(cy+half*0.95)*H))
    crop=img[Y0:Y1,X0:X1].copy()
    if crop.size==0: continue
    sc=a.h/crop.shape[0]
    crop=cv2.resize(crop,(int(crop.shape[1]*sc),a.h),interpolation=cv2.INTER_CUBIC)
    for i,j in CONN:
        if p[i][3]>0.25 and p[j][3]>0.25:
            pt1=(int((p[i][0]*W-X0)*sc),int((p[i][1]*H-Y0)*sc))
            pt2=(int((p[j][0]*W-X0)*sc),int((p[j][1]*H-Y0)*sc))
            cv2.line(crop,pt1,pt2,(0,255,0),2,cv2.LINE_AA)
    for q in p:
        if q[3]>0.25:
            cv2.circle(crop,(int((q[0]*W-X0)*sc),int((q[1]*H-Y0)*sc)),3,(0,140,255),-1,cv2.LINE_AA)
    cv2.putText(crop,'%.2fs'%f['t'],(6,22),cv2.FONT_HERSHEY_SIMPLEX,0.7,(0,255,255),2)
    tiles.append(crop)

if tiles:
    hh=max(t.shape[0] for t in tiles); ww=max(t.shape[1] for t in tiles)
    tiles=[cv2.copyMakeBorder(t,0,hh-t.shape[0],0,ww-t.shape[1],cv2.BORDER_CONSTANT,value=(20,20,20)) for t in tiles]
    while len(tiles)%4: tiles.append(np.full((hh,ww,3),20,np.uint8))
    rows=[np.hstack(tiles[i:i+4]) for i in range(0,len(tiles),4)]
    cv2.imwrite(a.out,np.vstack(rows),[cv2.IMWRITE_JPEG_QUALITY,88])
    print('saved',a.out,len(tiles))
