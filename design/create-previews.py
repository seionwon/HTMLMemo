from pathlib import Path
from html import escape
import subprocess

ROOT = Path(__file__).resolve().parent
ICONS = {
 'a-page': ('A', '페이지와 펜', '#343d59', '''<rect x="0" y="0" width="96" height="96" rx="23" fill="#343d59"/><path d="M27 20h30l13 13v43H27z" fill="#f8fafc"/><path d="M57 20v13h13" fill="#ccd4e8"/><path d="M37 43h20M37 52h16" stroke="#343d59" stroke-width="4" stroke-linecap="round"/><path d="m47 66 21-21 7 7-21 21-10 3z" fill="#f7c568"/><path d="m67 46 7 7" stroke="#343d59" stroke-width="3"/>'''),
 'b-monogram': ('B', 'H 모노그램', '#245e50', '''<rect x="0" y="0" width="96" height="96" rx="23" fill="#245e50"/><path d="M26 25h12v18h20V25h12v46H58V55H38v16H26z" fill="#fbfbf3"/><path d="M49 67h26" stroke="#f2cc70" stroke-width="8" stroke-linecap="round"/>'''),
 'c-web': ('C', '웹 북마크', '#6655c8', '''<rect x="0" y="0" width="96" height="96" rx="23" fill="#6655c8"/><rect x="19" y="24" width="58" height="47" rx="7" fill="none" stroke="#faf9ff" stroke-width="5"/><path d="M20 37h55" stroke="#faf9ff" stroke-width="4"/><circle cx="28" cy="31" r="2" fill="#faf9ff"/><circle cx="35" cy="31" r="2" fill="#faf9ff"/><path d="m34 47-8 7 8 7m11-14 8 7-8 7" fill="none" stroke="#faf9ff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M59 44h12v34l-6-5-6 5z" fill="#f4ce77"/>'''),
 'd-library': ('D', '열린 서재', '#b55b3c', '''<rect x="0" y="0" width="96" height="96" rx="23" fill="#b55b3c"/><path d="M19 27c13-5 22-2 29 4 8-6 17-9 29-4v43c-12-4-21-1-29 4-7-5-16-8-29-4z" fill="#fff9ed"/><path d="M48 32v41M28 41l11 3M28 51l11 3M57 44l11-3" fill="none" stroke="#b55b3c" stroke-width="3" stroke-linecap="round"/><path d="M60 26h10v28l-5-4-5 4z" fill="#e7b548"/>''')
}
THEMES = [
 {'id':1,'name':'포커스','tag':'명확하고 간결한 작업 공간','bg':'#eef0f5','bar':'#ffffff','paper':'#ffffff','text':'#22293a','muted':'#626c7d','line':'#dde2eb','accent':'#6554ca','soft':'#efecfa','logo':'c-web'},
 {'id':2,'name':'페이퍼','tag':'읽고 메모하기 편안한 서재','bg':'#f2eee5','bar':'#faf8f2','paper':'#fffdf7','text':'#303f36','muted':'#687269','line':'#deded0','accent':'#245e50','soft':'#e4ecdf','logo':'b-monogram'},
 {'id':3,'name':'잉크','tag':'차분한 다크 UI, 선명한 문서','bg':'#171c25','bar':'#232a36','paper':'#ffffff','text':'#e6ebf3','muted':'#a4aebe','line':'#384354','accent':'#94bbf4','soft':'#334a69','logo':'a-page'}
]
FONT='Apple SD Gothic Neo, Noto Sans CJK KR, sans-serif'

def svg(w,h,content,label):
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="title"><title id="title">{escape(label)}</title><g font-family="{FONT}">{content}</g></svg>'
def rect(x,y,w,h,fill,r=0,stroke='none'):
 return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}"/>'
def txt(x,y,s,size=16,color='#263247',weight=400):
 return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(s)}</text>'
def logo(key,x,y,size):
 return f'<g transform="translate({x} {y}) scale({size/96})">{ICONS[key][3]}</g>'
def line(x,y,w,color,h=6):return rect(x,y,w,h,color,h/2)
def glyph(name,x,y,color,size=20):
 paths={
  'back':'M15 5 8 12l7 7', 'forward':'M9 5l7 7-7 7','reload':'M19 8a8 8 0 1 0 1 8M19 3v5h-5',
  'folder':'M3 6h7l2 3h9v11H3z','search':'M16 16l5 5M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  'note':'M4 3h16v13l-5 5H4zM15 21v-6h5','pen':'m5 16 11-11 4 4L9 20H5zM14 7l4 4',
  'highlight':'m5 12 9-9 7 7-9 9-7-7M5 16l3 3-3 3H2z','underline':'M6 3v9a6 6 0 0 0 12 0V3M4 22h16',
  'cursor':'M5 3v17l5-5 4 7 3-2-4-7h7z','undo':'M3 10h10a7 7 0 0 1 0 14M3 10l5-5M3 10l5 5',
  'more':'M5 12h.01M12 12h.01M19 12h.01','shape':'M4 4h16v16H4z','check':'m5 12 4 4L19 6',
  'settings':'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  'download':'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5','plus':'M12 4v16M4 12h16'
 }
 return f'<g transform="translate({x} {y}) scale({size/24})"><path d="{paths[name]}" fill="none" stroke="{color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g>'

def shell(t,x,y,w,h,reader=False):
 c=''
 c+=rect(x,y,w,h,t['bg'],14,t['line'])
 c+=rect(x,y,w,54,t['bar'],14)
 c+=rect(x,y+30,w,24,t['bar'])
 c+=logo(t['logo'],x+18,y+14,28)+txt(x+56,y+34,'HTMLMemo',19,t['text'],600)
 c+=txt(x+w-145,y+33,'앱 설치',13,t['muted'])+glyph('settings',x+w-42,y+18,t['muted'],20)
 c+=rect(x,y+54,w,36,t['bar'])
 c+=rect(x+13,y+58,65,31,t['soft'],7)+txt(x+27,y+79,'내 서재',12,t['accent'],600)
 c+=txt(x+95,y+79,'실행',12,t['muted'])
 if reader:
  c+=rect(x+140,y+58,184,31,t['bg'],7)+txt(x+155,y+79,'생각을 기록하는 방법',12,t['text'])+txt(x+305,y+78,'×',14,t['muted'])
 c+=glyph('plus',x+(345 if reader else 140),y+65,t['muted'],18)
 c+=rect(x,y+90,w,47,t['bar'])
 c+=glyph('back',x+15,y+105,t['muted'],18)+glyph('forward',x+43,y+105,t['muted'],18)
 c+=rect(x+76,y+98,w-216,29,t['bg'],7)
 c+=txt(x+91,y+118,'로컬 · 읽기노트.html' if reader else '웹 주소 입력 또는 검색',11,t['muted'])
 c+=rect(x+w-129,y+98,111,29,t['accent'],7)
 bt='#1b283b' if t['id']==3 else '#ffffff'
 c+=txt(x+w-119,y+118,'HTML 내보내기' if reader else 'HTML 가져오기',11,bt,600)
 c+=rect(x,y+h-30,w,30,t['bar'])+glyph('check',x+15,y+h-22,t['accent'],15)+txt(x+36,y+h-10,'주석 자동 저장됨' if reader else '문서는 이 기기에 저장됩니다.',10,t['muted'])
 return c

def library(t,x,y,w,h):
 c=shell(t,x,y,w,h)
 top=y+173
 c+=txt(x+28,top,'내 서재',24,t['text'],600)+txt(x+28,top+27,'읽던 페이지, 남겨 둔 생각.',13,t['muted'])
 c+=rect(x+28,top+47,w-56,31,t['bar'],7,t['line'])+glyph('search',x+39,top+54,t['muted'],17)+txt(x+66,top+68,'제목 또는 주소로 찾기',11,t['muted'])
 c+=txt(x+28,top+105,'최근 읽은 문서',12,t['muted'],600)
 docs=[('생각을 기록하는 방법','메모 3개 · 방금 읽음','#f4e0ad'),('내가 좋아하는 문장들','밑줄 12개 · 어제','#e3ddee'),('배움은 연결에서 시작된다','메모 2개 · 10월 10일','#d6e5dc')]
 for i,(title,detail,color) in enumerate(docs):
  if t['id']==1:
   cx=x+28+(i%2)*(w-44)/2;cy=top+121+(i//2)*145;cw=(w-68)/2
   c+=rect(cx,cy,cw,130,t['bar'],9,t['line'])
   c+=rect(cx+12,cy+12,cw-24,48,t['bg'],5)+line(cx+24,cy+24,cw-56,color,6)+line(cx+24,cy+38,cw-65,'#b7bfcd',3)
   c+=txt(cx+12,cy+88,title[:11],12,t['text'],500)+txt(cx+12,cy+110,detail,9,t['muted'])
   continue
  cy=top+121+i*(81 if t['id']==3 else 87)
  c+=rect(x+28,cy,w-56,75,t['bar'],9,t['line'])
  c+=rect(x+42,cy+13,46,49,t['paper'],4,t['line'])
  c+=line(x+50,cy+23,27,color,5)+line(x+50,cy+34,25,'#a5b0b8',3)+line(x+50,cy+44,21,'#a5b0b8',3)
  c+=txt(x+101,cy+30,title,13,t['text'],500)+txt(x+101,cy+51,detail,10,t['muted'])
 return c

def reader(t,x,y,w,h):
 c=shell(t,x,y,w,h,True)
 px=x+(199 if t['id']==3 else 38);py=y+158;pw=w-(225 if t['id']==3 else 76);ph=h-215
 if t['id']==3:
  c+=txt(x+22,y+184,'목차',14,t['text'],600)
  for i,title in enumerate(['01  생각의 기록','02  문장에 남긴 표시','03  다시 읽는 시간']):
   c+=rect(x+15,y+204+i*41,164,32,t['soft'] if i==0 else t['bg'],6)
   c+=txt(x+26,y+225+i*41,title,11,t['accent'] if i==0 else t['muted'])
 c+=rect(px,py,pw,ph,t['paper'],5, '#deded6')
 ink='#303844';muted='#737c89'
 c+=txt(px+43,py+35,'READING NOTES  /  01',10,muted,500)
 c+=txt(px+43,py+83,'생각을 기록하는 방법',27,ink,600)
 c+=txt(px+43,py+112,'읽는 순간의 생각을 오래 남기기',13,muted)
 c+=line(px+43,py+137,pw-86,'#e5e8eb',1)
 c+=txt(px+43,py+174,'좋은 글을 읽다 보면 잠시 멈추고 싶은 순간이 있다.',15,ink)
 c+=rect(px+39,py+193,327,24,'#f4dc84',4)
 c+=txt(px+43,py+212,'기록은 기억의 빈틈을 채우는 작은 습관이다.',15,ink)
 c+=txt(px+43,py+249,'중요한 문장에 밑줄을 긋고, 내 생각을 곁에 남긴다.',15,ink)
 c+=txt(px+43,py+281,'다시 펼쳐 볼 때, 그날의 질문이 새로운 생각이 된다.',15,ink)
 c+=line(px+43,py+303,354,'#9aabb3',2)
 c+=rect(px+pw-207,py+325,165,66,'#fff6d8',8,'#e7cf91')
 c+=txt(px+pw-193,py+349,'다시 읽을 때 연결하기',12,'#675627',500)+txt(px+pw-193,py+372,'내 생각도 함께 남겨 두자.',11,'#77683f')
 c+=txt(px+43,py+352,'작은 표시 하나가 다음 읽기의 출발점이 된다.',13,muted)
 # A single compact floating toolbar. Its popovers are available in the live preview.
 tw=342;tx=px+(pw-tw)/2;ty=y+h-93
 c+=rect(tx,ty,tw,48,t['bar'],13,t['line'])
 actions=['cursor','highlight','underline','pen','note','shape']
 for i,name in enumerate(actions):
  ax=tx+10+i*39
  if name=='highlight':c+=rect(ax,ty+7,33,33,t['soft'],7)
  c+=glyph(name,ax+6,ty+13,t['accent'] if name=='highlight' else t['text'],21)
 c+=rect(tx+251,ty+13,19,19,'#efcf66',9)+line(tx+284,ty+10,1,t['line'],29)+glyph('undo',tx+296,ty+13,t['muted'],21)+glyph('more',tx+322,ty+13,t['muted'],18)
 return c

for key,(code,name,color,art) in ICONS.items():
 (ROOT/'icons'/f'{key}.svg').write_text(svg(96,96,art,name),encoding='utf8')
 for size in [192,512]:
  subprocess.run(['rsvg-convert','-w',str(size),'-h',str(size),str(ROOT/'icons'/f'{key}.svg'),'-o',str(ROOT/'icons'/f'{key}-{size}.png')],check=True)

board=rect(0,0,1440,470,'#f2f3f5')+txt(32,45,'HTMLMemo · 아이콘 4종',28,'#263247',600)
for i,(key,(code,name,color,art)) in enumerate(ICONS.items()):
 x=32+i*352
 board+=rect(x,73,320,365,'#ffffff',18,'#e1e5eb')+txt(x+25,110,code+'  '+name,22,'#263247',600)
 board+=logo(key,x+91,138,138)
 board+=txt(x+25,309,'작은 크기에서도 비교해 보세요',14,'#657084')
 for j,size in enumerate([16,32,64]):
  board+=logo(key,x+28+j*92,331+(64-size)/2,size)+txt(x+27+j*92,417,str(size)+' px',13,'#657084')
(ROOT/'icon-options.svg').write_text(svg(1440,470,board,'HTMLMemo 아이콘 A 페이지와 펜, B H 모노그램, C 웹 북마크, D 열린 서재'),encoding='utf8')
subprocess.run(['rsvg-convert',str(ROOT/'icon-options.svg'),'-o',str(ROOT/'icon-options.png')],check=True)
for t in THEMES:
 board=rect(0,0,1440,830,'#f2f3f5')+txt(28,48,f"{t['id']} · {t['name']}",28,'#263247',600)+txt(220,46,t['tag'],18,'#667183')
 board+=txt(28,91,'서재',17,'#667183',500)+txt(470,91,'읽기 · 주석',17,'#667183',500)
 board+=library(t,28,109,408,680)+reader(t,470,109,942,680)
 out=ROOT/f"design-{t['id']}.svg";out.write_text(svg(1440,830,board,t['name']+' HTMLMemo 서재와 읽기 화면 디자인 시안'),encoding='utf8')
 subprocess.run(['rsvg-convert',str(out),'-o',str(ROOT/f"design-{t['id']}.png")],check=True)
print('Created four original vector icons, eight icon PNGs, and three interface concept boards.')
