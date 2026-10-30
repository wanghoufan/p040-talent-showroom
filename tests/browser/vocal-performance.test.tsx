import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {DanceItem,MediaFile,TalentItem,TimedLyric,VocalSection} from '../../src/lib/types';

// 可控延迟：用于复现「切曲时旧音轨异步解析回写」的竞争。
const cacheHooks=vi.hoisted(()=>({delayMs:new Map<string,number>()}));

vi.mock('../../src/native/filesystem',()=>({
  isOfflineSupported:()=>true,
  offlineUrl:(uri:string)=>uri,
  cachedFileValid:async(entry:{key:string})=>{
    const delay=cacheHooks.delayMs.get(entry.key)??0;
    if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
    return true;
  },
}));

import PerformancePage from '../../src/pages/PerformancePage';

const media=(id:string):MediaFile=>({id,url:`/api/media/audio/${id}`,sha256:`sha-${id}`,sizeBytes:10,version:1,durationMs:66000});
const line=(startMs:number,text:string):TimedLyric=>({id:`l-${startMs}`,startMs,text});
const section=(input:Partial<VocalSection>&Pick<VocalSection,'id'>):VocalSection=>({type:'verse',label:input.id,startMs:0,endMs:1000,source:'manual',...input});
const lyrics:TimedLyric[]=[line(0,'第一句'),line(4000,'第二句'),line(8000,'第三句')];
const sections:VocalSection[]=[
  section({id:'s1',type:'verse',label:'A1',startMs:0,endMs:6000}),
  section({id:'s2',type:'chorus',label:'B1',startMs:6000,endMs:20000}),
];

function vocal(id:string,extra:Partial<TalentItem>={}):TalentItem{
  return {id,kind:'VOCAL',title:`歌-${id}`,artist:'原创演示',learningStatus:'CAN_DANCE',originalKey:'C',performanceKey:'C',capo:0,scoreText:'',notes:'',audioRole:'ACCOMPANIMENT',durationMs:66000,...extra};
}
function dance(id:string):DanceItem{
  return {id,title:`舞-${id}`,artist:'演示',learningStatus:'CAN_DANCE',sceneTags:[],performanceClipId:`clip-${id}`,audio:media(`dance-${id}`),durationMs:60000};
}
function guitar(id:string,audioId?:string):TalentItem{
  return {id,kind:'GUITAR',title:`吉他-${id}`,artist:'演示',learningStatus:'CAN_DANCE',originalKey:'C',performanceKey:'C',capo:2,scoreText:'',notes:'',audioRole:'ACCOMPANIMENT',durationMs:60000,...(audioId?{audio:media(audioId)}:{})};
}
function seed(program:{kind:'DANCE'|'GUITAR'|'VOCAL';id:string}[],repertoire:TalentItem[],catalog:DanceItem[],cached:string[]){
  localStorage.setItem('dance.program',JSON.stringify({revision:1,items:program}));
  localStorage.setItem('dance.repertoire-snapshot',JSON.stringify(repertoire));
  localStorage.setItem('dance.catalog-snapshot',JSON.stringify(catalog));
  localStorage.setItem('dance.offline.cache',JSON.stringify(Object.fromEntries(cached.map(id=>{
    const key=`/api/media/audio/${id}`;
    return [key,{key,sha256:`sha-${id}`,version:1,sizeBytes:10,path:`p/${id}`,uri:`file:///data/${id}.mp3`}];
  }))));
}
const audioOf=():HTMLAudioElement=>{
  const element=document.querySelector('audio');
  if(!element)throw new Error('missing audio element');
  return element;
};

let play:ReturnType<typeof vi.spyOn>;

beforeEach(()=>{
  localStorage.clear();
  cacheHooks.delayMs.clear();
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new TypeError('offline');}));
  play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  // jsdom 不实现真实媒体加载/暂停：桩掉以免刷屏，事件由测试手动触发。
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>undefined);
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>undefined);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('唱歌默认选中伴奏，按 item.tracks 加载伴奏并同步歌词与结构',async()=>{
  seed([{kind:'VOCAL',id:'v1'}],[vocal('v1',{tracks:{original:{media:media('orig')},accompaniment:{media:media('acc')}},lyrics,sections})],[],['orig','acc']);
  render(<PerformancePage/>);
  const backing=await screen.findByRole('button',{name:/♫ 伴奏/});
  expect(backing).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:/♬ 原唱/})).toHaveAttribute('aria-pressed','false');

  const audio=audioOf();
  await waitFor(()=>expect(audio.getAttribute('src')).toContain('/acc'));
  audio.currentTime=5;
  fireEvent.timeUpdate(audio);
  expect(screen.getByRole('button',{name:'第二句'})).toHaveAttribute('aria-current','true');
  expect(screen.getByText('当前段落：A1')).toBeVisible();
});

it('演出按音轨 offsetMs 把文件时钟换算成共享歌词时间，timeupdate 与点句定位都对齐',async()=>{
  seed([{kind:'VOCAL',id:'v1'}],[vocal('v1',{tracks:{accompaniment:{media:media('acc'),offsetMs:500}},lyrics,sections})],[],['acc']);
  render(<PerformancePage/>);
  await waitFor(()=>expect(audioOf().getAttribute('src')).toContain('/acc'));
  const audio=audioOf();
  // 文件时钟 4.2s，伴奏比歌词时间轴晚 0.5s → 歌词时间 3.7s，仍在第一句。
  audio.currentTime=4.2;
  fireEvent.timeUpdate(audio);
  expect(screen.getByRole('button',{name:'第一句'})).toHaveAttribute('aria-current','true');

  // 点第二句（歌词 4s）应定位到文件 4.5s，而不是 4.0s。
  fireEvent.click(screen.getByRole('button',{name:'第二句'}));
  expect(audio.currentTime).toBeCloseTo(4.5,2);
});

it('切轨后按目标音轨 offsetMs 还原位置，不把文件时钟当成歌词时间',async()=>{
  seed([{kind:'VOCAL',id:'v1'}],[vocal('v1',{tracks:{accompaniment:{media:media('acc')},original:{media:media('orig'),offsetMs:800}},lyrics})],[],['orig','acc']);
  render(<PerformancePage/>);
  await waitFor(()=>expect(audioOf().getAttribute('src')).toContain('/acc'));
  const audio=audioOf();
  audio.currentTime=3.6;
  fireEvent.timeUpdate(audio);
  expect(screen.getByRole('button',{name:'第一句'})).toHaveAttribute('aria-current','true');

  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/♬ 原唱/}));});
  fireEvent.loadedMetadata(audio);
  await act(async()=>{});

  // 原唱文件比歌词晚 0.8s：文件位置 4.4s 仍对应歌词 3.6s，界面必须继续停在第一句。
  expect(audio.currentTime).toBeCloseTo(4.4,2);
  expect(screen.getByRole('button',{name:'第一句'})).toHaveAttribute('aria-current','true');
});

it('同源原唱与伴奏不算真实双轨：不当作伴奏播出，并明确提示禁止假伴奏',async()=>{
  seed([{kind:'VOCAL',id:'v9'}],[vocal('v9',{tracks:{original:{media:media('same')},accompaniment:{media:media('same')}},lyrics})],[],['same']);
  render(<PerformancePage/>);
  const backing=await screen.findByRole('button',{name:/♫ 伴奏/});
  expect(backing).toBeDisabled();
  expect(backing).toHaveAttribute('aria-pressed','false');
  expect(screen.getByRole('alert')).toHaveTextContent('不能当作真实双轨');
  // 不自动加载：既不冒充伴奏，也不擅自开播原唱。
  expect(audioOf().getAttribute('src')).toBeNull();
  expect(play).not.toHaveBeenCalled();
});

it('切轨保持当前位置与暂停状态，不重新开始也不自动出声',async()=>{
  seed([{kind:'VOCAL',id:'v1'}],[vocal('v1',{tracks:{original:{media:media('orig')},accompaniment:{media:media('acc')}},lyrics})],[],['orig','acc']);
  render(<PerformancePage/>);
  await waitFor(()=>expect(audioOf().getAttribute('src')).toContain('/acc'));
  const audio=audioOf();
  audio.currentTime=12;
  fireEvent.timeUpdate(audio);

  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/♬ 原唱/}));});
  fireEvent.loadedMetadata(audio);
  await act(async()=>{});

  expect(audio.getAttribute('src')).toContain('/orig');
  expect(audio.currentTime).toBeCloseTo(12,1);
  expect(play).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:/♬ 原唱/})).toHaveAttribute('aria-pressed','true');
});

it('播放中切轨继续播放并停在同一点',async()=>{
  seed([{kind:'VOCAL',id:'v1'}],[vocal('v1',{tracks:{original:{media:media('orig')},accompaniment:{media:media('acc')}},lyrics})],[],['orig','acc']);
  render(<PerformancePage/>);
  await waitFor(()=>expect(audioOf().getAttribute('src')).toContain('/acc'));
  const audio=audioOf();
  Object.defineProperty(audio,'paused',{configurable:true,get:()=>false});
  audio.currentTime=21;
  fireEvent.timeUpdate(audio);

  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/♬ 原唱/}));});
  fireEvent.loadedMetadata(audio);
  await act(async()=>{});

  expect(audio.currentTime).toBeCloseTo(21,1);
  expect(play).toHaveBeenCalledTimes(1);
});

it('缺伴奏时明确提示并禁用伴奏，不把原唱当伴奏自动播出',async()=>{
  seed([{kind:'VOCAL',id:'v2'}],[vocal('v2',{tracks:{original:{media:media('orig')}},lyrics})],[],['orig']);
  render(<PerformancePage/>);
  const backing=await screen.findByRole('button',{name:/伴奏（未提供）/});
  expect(backing).toBeDisabled();
  expect(backing).toHaveAttribute('aria-pressed','false');
  expect(screen.getByRole('alert')).toHaveTextContent('未提供伴奏');

  const audio=audioOf();
  expect(audio.getAttribute('src')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'播放'}));
  expect(screen.getAllByRole('alert').some(element=>element.textContent?.includes('请选择「伴奏」或「原唱」'))).toBe(true);

  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/♬ 原唱/}));});
  await waitFor(()=>expect(audio.getAttribute('src')).toContain('/orig'));
  expect(play).not.toHaveBeenCalled();
});

it('切换曲目停止播放并重置为伴奏，等待手动播放',async()=>{
  seed([{kind:'VOCAL',id:'v1'},{kind:'VOCAL',id:'v3'}],[
    vocal('v1',{tracks:{accompaniment:{media:media('acc1')}},lyrics}),
    vocal('v3',{title:'第二首',tracks:{accompaniment:{media:media('acc2')}},lyrics}),
  ],[],['acc1','acc2']);
  render(<PerformancePage/>);
  await waitFor(()=>expect(audioOf().getAttribute('src')).toContain('/acc1'));
  const audio=audioOf();
  audio.currentTime=30;
  fireEvent.timeUpdate(audio);
  fireEvent.play(audio);
  expect(screen.getByRole('button',{name:'暂停'})).toBeVisible();

  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'下一首'}));});
  expect(screen.getByRole('button',{name:'播放'})).toBeVisible();
  expect(screen.getByRole('button',{name:/♫ 伴奏/})).toHaveAttribute('aria-pressed','true');
  expect(audio.currentTime).toBeCloseTo(0,1);
  await waitFor(()=>expect(audio.getAttribute('src')).toContain('/acc2'));
  expect(play).not.toHaveBeenCalled();
});

it('保留舞蹈/吉他/唱歌混排，且演出页不出现练唱的跳过 Rap、合练与倍速',async()=>{
  seed([
    {kind:'DANCE',id:'d1'},
    {kind:'GUITAR',id:'g1'},
    {kind:'VOCAL',id:'v1'},
  ],[
    vocal('v1',{tracks:{accompaniment:{media:media('acc')}},lyrics}),
    {id:'g1',kind:'GUITAR',title:'吉他曲',artist:'演示',learningStatus:'CAN_DANCE',originalKey:'C',performanceKey:'C',capo:2,scoreText:'[C]第一行',notes:'',audioRole:'ACCOMPANIMENT',audio:media('gtr'),durationMs:60000},
  ],[dance('d1')],['acc','gtr','dance-d1']);

  render(<PerformancePage/>);
  const list=await screen.findByRole('list',{name:'当晚节目单'});
  expect(list).toHaveTextContent('舞-d1');
  expect(list).toHaveTextContent('吉他曲');
  expect(list).toHaveTextContent('歌-v1');

  fireEvent.click(screen.getByRole('button',{name:/吉他曲/}));
  expect(screen.queryByRole('button',{name:/伴奏/})).not.toBeInTheDocument();
  expect(screen.getByText('[C]第一行')).toBeVisible();

  expect(screen.queryByRole('button',{name:'跳过 Rap'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'合练一遍'})).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox',{name:'播放速度'})).not.toBeInTheDocument();
});

it('舞蹈曲目进入即加载单音轨，可手动播放与暂停，不自动出声',async()=>{
  seed([{kind:'DANCE',id:'d1'}],[],[dance('d1')],['dance-d1']);
  render(<PerformancePage/>);
  await screen.findByText('舞-d1');

  const audio=audioOf();
  await waitFor(()=>expect(audio.getAttribute('src')).toContain('/dance-d1'));
  expect(play).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:/伴奏/})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'重播'})).toBeEnabled();

  fireEvent.click(screen.getByRole('button',{name:'播放'}));
  await waitFor(()=>expect(play).toHaveBeenCalledTimes(1));
  fireEvent.play(audio);
  expect(screen.getByRole('button',{name:'暂停'})).toBeVisible();

  fireEvent.click(screen.getByRole('button',{name:'暂停'}));
  fireEvent.pause(audio);
  expect(screen.getByRole('button',{name:'播放'})).toBeVisible();
});

it('吉他曲目同样加载并播放单音轨，缺音频时才提示只有文本',async()=>{
  seed([{kind:'GUITAR',id:'g1'},{kind:'GUITAR',id:'g2'}],[guitar('g1','gtr'),guitar('g2')],[],['gtr']);
  render(<PerformancePage/>);
  await screen.findByText('吉他-g1');

  const audio=audioOf();
  await waitFor(()=>expect(audio.getAttribute('src')).toContain('/gtr'));
  fireEvent.click(screen.getByRole('button',{name:'播放'}));
  await waitFor(()=>expect(play).toHaveBeenCalledTimes(1));

  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'下一首'}));});
  await waitFor(()=>expect(audio.getAttribute('src')).toBeNull());
  expect(screen.getByRole('button',{name:'重播'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'播放'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('只保存了文本'));
  expect(play).toHaveBeenCalledTimes(1);
});

it('未缓存的舞蹈曲目提示先准备离线，不加载音轨也不自动播放',async()=>{
  seed([{kind:'DANCE',id:'d2'}],[],[dance('d2')],[]);
  render(<PerformancePage/>);
  await screen.findByText('舞-d2');

  const audio=audioOf();
  await waitFor(()=>expect(screen.getByRole('button',{name:'重播'})).toBeEnabled());
  await act(async()=>{await Promise.resolve();});
  expect(audio.getAttribute('src')).toBeNull();

  fireEvent.click(screen.getByRole('button',{name:'播放'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('尚未下载或文件已丢失'));
  expect(play).not.toHaveBeenCalled();
});

it('快速切曲时旧曲目的异步解析不会回写到新曲目',async()=>{
  cacheHooks.delayMs.set('/api/media/audio/dance-d1',40);
  seed([{kind:'DANCE',id:'d1'},{kind:'DANCE',id:'d2'}],[],[dance('d1'),dance('d2')],['dance-d1']);
  render(<PerformancePage/>);
  await screen.findByText('舞-d1');

  const audio=audioOf();
  // 上一首的地址仍在解析中，此时切到没有缓存文件的下一首。
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'下一首'}));});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,80));});

  expect(audio.getAttribute('src')).toBeNull();
  expect(play).not.toHaveBeenCalled();
});
