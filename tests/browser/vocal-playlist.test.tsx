import {fireEvent,render,screen} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import type {DanceItem,MediaFile,TalentItem,TimedLyric,VocalSection} from '../../src/lib/types';

vi.mock('../../src/native/filesystem',()=>({
  isOfflineSupported:()=>false,
  offlineUrl:(uri:string)=>uri,
  cachedFileValid:async()=>true,
  downloadMedia:async()=>{throw new Error('no download in jsdom');},
  playbackSource:()=>'',
}));

import TonightPlaylistPage,{programRowStatus,vocalPrepIssues,type VocalPrepIssue} from '../../src/pages/TonightPlaylistPage';
import type {CachedIndex} from '../../src/lib/offline-manifest';

const media=(id:string):MediaFile=>({id,url:`/api/media/audio/${id}`,sha256:`sha-${id}`,sizeBytes:10,version:1,durationMs:66000});
const line=(startMs:number,text:string):TimedLyric=>({id:`l-${startMs}`,startMs,text});
const section=(input:Partial<VocalSection>&Pick<VocalSection,'id'>):VocalSection=>({type:'verse',label:input.id,startMs:0,endMs:1000,source:'manual',...input});
const cachedOf=(ids:string[]):CachedIndex=>Object.fromEntries(ids.map(id=>{
  const key=`/api/media/audio/${id}`;
  return [key,{key,sha256:`sha-${id}`,version:1,sizeBytes:10,path:`p/${id}`,uri:`file:///data/${id}.mp3`}];
}));

function vocal(id:string,extra:Partial<TalentItem>={}):TalentItem{
  return {id,kind:'VOCAL',title:`歌-${id}`,artist:'原创演示',learningStatus:'CAN_DANCE',originalKey:'C',performanceKey:'C',capo:0,scoreText:'',notes:'',audioRole:'ACCOMPANIMENT',durationMs:66000,...extra};
}
const lyrics=[line(0,'第一句'),line(4000,'第二句')];
const sections=[section({id:'s1',label:'A1',startMs:0,endMs:20000})];

beforeEach(()=>{localStorage.clear();vi.stubGlobal('fetch',vi.fn(async()=>{throw new TypeError('offline');}));});

it('节目单行状态如实区分伴奏就绪、仅有原唱与纯文本',()=>{
  const dual=vocal('v1',{tracks:{original:{media:media('orig')},accompaniment:{media:media('acc')}}});
  const onlyOriginal=vocal('v2',{tracks:{original:{media:media('orig')}}});
  const notCached=vocal('v3',{tracks:{accompaniment:{media:media('acc')}}});
  const textVocal=vocal('v4',{scoreText:'只有歌词'});
  const dance:DanceItem&{kind:'DANCE'}={id:'d1',kind:'DANCE',title:'舞',artist:'演示',learningStatus:'CAN_DANCE',sceneTags:[],performanceClipId:'c1',audio:media('dance'),durationMs:60000};
  const cached=cachedOf(['orig','acc','dance']);
  expect(programRowStatus(dual,cached)).toBe('伴奏已缓存');
  expect(programRowStatus(onlyOriginal,cached)).toBe('未提供伴奏（仅原唱）');
  expect(programRowStatus(notCached,cachedOf([]))).toBe('伴奏未缓存');
  expect(programRowStatus(textVocal,cached)).toBe('文本曲目');
  expect(programRowStatus(dance,cached)).toBe('已缓存');
  expect(programRowStatus(dance,cachedOf([]))).toBe('未缓存');
});

it('准备明细逐首列出缺失音轨、歌词时间轴与结构状态',()=>{
  const dual=vocal('v1',{tracks:{original:{media:media('orig')},accompaniment:{media:media('acc')}},lyrics,sections});
  const onlyOriginal=vocal('v2',{tracks:{original:{media:media('orig')}},scoreText:'纯文本歌词'});
  const issues:VocalPrepIssue[]=vocalPrepIssues([dual,onlyOriginal,vocal('v3',{scoreText:'纯文本'})],cachedOf(['orig']));
  expect(issues).toHaveLength(2);
  expect(issues[0]).toMatchObject({title:'歌-v1',missing:['伴奏未缓存'],lyrics:'歌词 2 句（带时间）',sections:'结构 1 段'});
  expect(issues[1]).toMatchObject({title:'歌-v2',missing:['伴奏未提供'],lyrics:'歌词为纯文本（无时间戳）',sections:'未标注结构'});
});

it('同源原唱与伴奏不算真实双轨，节目单行与准备明细都照实标出',()=>{
  const duplicated=vocal('v5',{tracks:{original:{media:media('same')},accompaniment:{media:media('same')}}});
  const cached=cachedOf(['same']);
  expect(programRowStatus(duplicated,cached)).toBe('伴奏与原唱为同一文件');
  expect(vocalPrepIssues([duplicated],cached)[0].missing).toEqual(['伴奏与原唱为同一文件']);
});

it('准备结果按曲目报出具体缺轨，不用笼统的「音轨缺失」糊过去',async()=>{
  const onlyOriginal=vocal('v2',{tracks:{original:{media:media('orig')}},lyrics,sections});
  localStorage.setItem('dance.program',JSON.stringify({revision:1,items:[{kind:'VOCAL',id:'v2'}]}));
  localStorage.setItem('dance.repertoire-snapshot',JSON.stringify([onlyOriginal]));
  localStorage.setItem('dance.catalog-snapshot','[]');

  render(<TonightPlaylistPage/>);
  expect(await screen.findByText(/歌-v2/)).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'准备离线演出'}));

  const status=await screen.findByRole('status');
  expect(status).toHaveTextContent(/仍有资源未就绪/);
  expect(status).toHaveTextContent('歌-v2·伴奏未提供');
});

it('准备离线演出复用现有同步，并明确报告缺轨且不宣称解码验证',async()=>{
  const item=vocal('v1',{tracks:{original:{media:media('orig')}},lyrics,sections});
  localStorage.setItem('dance.program',JSON.stringify({revision:1,items:[{kind:'VOCAL',id:'v1'}]}));
  localStorage.setItem('dance.repertoire-snapshot',JSON.stringify([item]));
  localStorage.setItem('dance.catalog-snapshot','[]');

  render(<TonightPlaylistPage/>);
  expect(await screen.findByText(/歌-v1/)).toBeVisible();
  expect(screen.getByText(/未提供伴奏（仅原唱）/)).toBeVisible();

  fireEvent.click(screen.getByRole('button',{name:'准备离线演出'}));

  const status=await screen.findByRole('status');
  expect(status).toHaveTextContent(/仍有资源未就绪/);
  const detail=await screen.findByRole('list',{name:'离线准备明细'});
  expect(detail).toHaveTextContent('伴奏未提供');
  expect(detail).toHaveTextContent('歌词 2 句（带时间）');
  expect(detail).toHaveTextContent('结构 1 段');
  expect(screen.getByText(/不做音频解码验证/)).toBeVisible();
  expect(screen.queryByText(/解码验证通过|已通过解码/)).not.toBeInTheDocument();
});
