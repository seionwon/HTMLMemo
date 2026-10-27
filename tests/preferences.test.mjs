import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreferences, loadPreferences, storePreferences, serializeSettings, parseSettings, readSettingsFile, PREFERENCES_KEY, PRESET_COLORS, PRESET_PALETTES, normalizeHexColor, hexToRgb, rgbToHex, hexToHsv, hsvToHex } from '../public/src/preferences.js';
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values};};
test('pen and highlighter colors stay independent through storage and portable settings, rejecting malformed highlight colors',()=>{
  const local=storage(),preferences=storePreferences({annotation:{color:'#334155',highlightColor:'#F39DA2'}},local);
  assert.equal(preferences.annotation.highlightColor,'#f39da2');assert.equal(preferences.annotation.color,'#334155');
  assert.deepEqual(loadPreferences(local),preferences);assert.deepEqual(parseSettings(serializeSettings(preferences)).preferences,preferences);
  assert.equal(normalizePreferences().annotation.highlightColor,'#edcf67');
  for(const highlightColor of [null,42,{},[],true,'red','#abc','#12345678','url(x)'])assert.throws(()=>normalizePreferences({annotation:{highlightColor}}),/주석 색상/);
});
test('all portable preferences round trip through a local settings file',async()=>{const preferences=normalizePreferences({theme:'dark',librarySort:'title',librarySortDirection:'desc',libraryView:'list',annotation:{color:'#123456',width:9,opacity:.7,penTTL:10},toolbarPosition:{x:.2,y:.8}});const json=serializeSettings(preferences,'My HTML');const result=await readSettingsFile(new File([json],'settings.json'));assert.deepEqual(result,{preferences,folderName:'My HTML'});assert.equal(JSON.parse(json).storage,'local');});
test('preferences stay in local storage and migrate the existing theme',()=>{const local=storage();local.setItem('htmlmemo-theme','dark');assert.equal(loadPreferences(local).theme,'dark');const expected=storePreferences({theme:'system',librarySort:'created'},local);assert.deepEqual(loadPreferences(local),expected);assert.ok(local.values.has(PREFERENCES_KEY));});
test('a backup contains no document data, file handles or arbitrary properties',()=>{const text=serializeSettings({theme:'light',documents:['PRIVATE-DOCUMENT'],fileHandle:{name:'PRIVATE-PATH'},annotation:{color:'#123456',secret:'PRIVATE-TOKEN'}},'folder');assert.ok(!text.includes('PRIVATE'));assert.deepEqual(Object.keys(JSON.parse(text).preferences),['theme','librarySort','librarySortDirection','libraryView','annotation','toolbarPosition','sidebarWidth']);});
test('sidebar width migrates old settings, round-trips with portable preferences and rejects invalid values',()=>{
  const local=storage();assert.equal(loadPreferences(local).sidebarWidth,300);assert.equal(normalizePreferences({}).sidebarWidth,300);
  const preferences=storePreferences({sidebarWidth:420.4},local);assert.equal(loadPreferences(local).sidebarWidth,420);assert.equal(parseSettings(serializeSettings(preferences)).preferences.sidebarWidth,420);
  for(const sidebarWidth of [8,179,640]){storePreferences({sidebarWidth},local);assert.equal(loadPreferences(local).sidebarWidth,sidebarWidth);assert.equal(parseSettings(serializeSettings(loadPreferences(local))).preferences.sidebarWidth,sidebarWidth);}
  for(const sidebarWidth of [NaN,Infinity,0,7,641,'420',{},-1])assert.throws(()=>normalizePreferences({sidebarWidth}),/사이드바 폭/);
});
test('library view defaults to cards, persists lists and rejects unknown modes',()=>{const local=storage();assert.equal(loadPreferences(local).libraryView,'card');storePreferences({libraryView:'list'},local);assert.equal(loadPreferences(local).libraryView,'list');assert.throws(()=>normalizePreferences({libraryView:'tiles'}));});
test('damaged, future, oversized and remote-storage settings are rejected before applying',()=>{const base=JSON.parse(serializeSettings({}));for(const input of [{...base,storage:'cloud'},{...base,version:2},{...base,preferences:{theme:'invalid'}},{...base,preferences:{annotation:{width:100}}},{...base,preferences:{toolbarPosition:{x:NaN,y:2}}}])assert.throws(()=>parseSettings(JSON.stringify(input)));assert.throws(()=>parseSettings('bad json'));assert.throws(()=>parseSettings(' '.repeat(131073)));});
test('reloading a connected handle reads the latest bytes rather than a cached file',async()=>{let json=serializeSettings({theme:'light'});const handle={kind:'file',getFile:async()=>new File([json],'settings.json')};assert.equal((await readSettingsFile(handle)).preferences.theme,'light');json=serializeSettings({theme:'dark'});assert.equal((await readSettingsFile(handle)).preferences.theme,'dark');});
test('20 preset colors, 20 preset palettes, user custom colors/palettes, and color picker HSV/RGB/HEX conversions work and round-trip',()=>{
  assert.equal(PRESET_COLORS.length,20);
  assert.equal(PRESET_PALETTES.length,20);
  for(const c of PRESET_COLORS)assert.match(c,/^#[\da-f]{6}$/);
  for(const p of PRESET_PALETTES){assert.ok(p.id&&p.name&&p.colors.length>=8);for(const c of p.colors)assert.match(c,/^#[\da-f]{6}$/);}
  assert.equal(normalizeHexColor(' #F0A '), '#ff00aa');
  assert.deepEqual(hexToRgb('#3b82f6'), {r:59,g:130,b:246});
  assert.equal(rgbToHex({r:59,g:130,b:246}), '#3b82f6');
  const hsv = hexToHsv('#ff0000');
  assert.deepEqual(hsv, {h:0,s:100,v:100});
  assert.equal(hsvToHex({h:120,s:100,v:100}), '#00ff00');
  const prefs = normalizePreferences({annotation:{color:'#3B82F6',paletteId:'custom-1',customColors:['#AABBCC','#aabbcc','#112233'],customPalettes:[{id:'custom-1',name:'내 팔레트',colors:['#AABBCC','#3B82F6']}]}});
  assert.deepEqual(prefs.annotation.customColors,['#aabbcc','#112233']);
  assert.deepEqual(prefs.annotation.customPalettes,[{id:'custom-1',name:'내 팔레트',colors:['#aabbcc','#3b82f6']}]);
  assert.equal(prefs.annotation.paletteId,'custom-1');
});

test('sort directions preserve legacy ordering and round-trip through preferences and backups',()=>{
  for(const librarySort of ['modified','created','title']){
    assert.equal(normalizePreferences({librarySort}).librarySortDirection,librarySort==='title'?'asc':'desc');
    for(const librarySortDirection of ['asc','desc']){
      const local=storage(),expected=storePreferences({librarySort,librarySortDirection},local);
      assert.deepEqual(loadPreferences(local),expected);
      assert.deepEqual(parseSettings(serializeSettings(expected)).preferences,expected);
    }
  }
  const legacy={format:'HTMLMemo.settings',version:1,storage:'local',preferences:{librarySort:'title'}};
  assert.equal(parseSettings(JSON.stringify(legacy)).preferences.librarySortDirection,'asc');
  for(const librarySortDirection of ['sideways','ASC',12,false])assert.throws(()=>normalizePreferences({librarySortDirection}));
});
