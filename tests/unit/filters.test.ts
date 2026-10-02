import { expect,it } from 'vitest';
import { filterDances,SCENE_OPTIONS,STATUS_OPTIONS } from '../../src/lib/filters';
import type { DanceItem } from '../../src/lib/types';
it('全部状态及16种标签筛选严格取AND，清除状态不会丢掉零标签项目',()=>{
  const items:DanceItem[]=[];
  for(const status of STATUS_OPTIONS)for(let mask=0;mask<16;mask++){
    items.push({id:`${status.id}-${mask}`,title:'测试',artist:'歌手',learningStatus:status.id,sceneTags:SCENE_OPTIONS.filter((_,i)=>mask&(1<<i)).map(o=>o.id),performanceClipId:'clip',durationMs:1000,audio:{id:'clip',url:'/audio',sha256:'x',sizeBytes:1,version:1}});
  }
  for(const status of [null,...STATUS_OPTIONS.map(s=>s.id)])for(let mask=0;mask<16;mask++){
    const scenes=SCENE_OPTIONS.filter((_,i)=>mask&(1<<i)).map(s=>s.id);
    const expected=items.filter(i=>(!status||i.learningStatus===status)&&((Number(i.id.split('-').at(-1))&mask)===mask)).map(i=>i.id);
    expect(filterDances(items,status,scenes).map(i=>i.id)).toEqual(expected);
  }
  expect(filterDances(items,null,[],'找不到')).toHaveLength(0);
  expect(filterDances(items,null,[],'歌手')).toHaveLength(48);
});
