import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import GuestRequestPage from '../../src/pages/GuestRequestPage';
it('局域网HTTP没有randomUUID时仍可点歌，提交只含接口允许字段',async()=>{
 const nativeCrypto=globalThis.crypto;vi.stubGlobal('crypto',{getRandomValues:nativeCrypto.getRandomValues.bind(nativeCrypto)});
 const id='00000000-0000-4000-8000-000000000001',bodies:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST'){bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({state:'PENDING'}));}return new Response(JSON.stringify({items:[{kind:'VOCAL',id,title:'公开标题'}]}));}));
 render(<MemoryRouter initialEntries={['/request/example']}><Routes><Route path="/request/:token" element={<GuestRequestPage/>}/></Routes></MemoryRouter>);
 fireEvent.click(await screen.findByText('点这首'));await waitFor(()=>expect(bodies).toHaveLength(1));
 expect(bodies[0]).toEqual({kind:'VOCAL',id,visitor:expect.stringMatching(/^[a-f0-9-]{36}$/),nickname:'',note:''});expect(await screen.findByText(/已提交/)).toBeInTheDocument();vi.unstubAllGlobals();
});
