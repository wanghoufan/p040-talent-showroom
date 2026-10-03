import { getDance } from '../catalog.mjs';
import { getRepertoire } from '../repertoire/service.mjs';
export const refKey=r=>`${r.kind}:${r.id}`;
export const tableFor=kind=>kind==='DANCE'?'dance_items':['GUITAR','VOCAL'].includes(kind)?'repertoire_items':null;
export function validateRefs(refs,{empty=false,max=1000}={}){
 if(!Array.isArray(refs)||(!empty&&!refs.length)||refs.length>max||refs.some(r=>!r||Object.keys(r).some(k=>!['kind','id'].includes(k))||!tableFor(r.kind)||typeof r.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.id))||new Set(refs.map(refKey)).size!==refs.length)throw Error('BAD_REQUEST');return refs;
}
export function rowFor(db,ref){const table=tableFor(ref.kind);if(!table)throw Error('BAD_REQUEST');return db.prepare(`SELECT * FROM ${table} WHERE id=?${ref.kind==='DANCE'?'':' AND kind=?'}`).get(...(ref.kind==='DANCE'?[ref.id]:[ref.id,ref.kind]));}
export function itemFor(db,ref){return ref.kind==='DANCE'?getDance(db,ref.id):getRepertoire(db,ref.id);}
