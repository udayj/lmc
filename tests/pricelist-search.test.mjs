import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingPricelists } from '../js/pricelist-search.js';
const items = [
 { id:'1', brand:'kei', title:'PV Solar Cable LP -10th Aug 2026', keywords:['latest dc cable'] },
 { id:'2', brand:'polycab', title:'PCC LP No. 05 Dtd 14th August 2026', keywords:['latest armoured','copper power cable'] },
 ...Array.from({length:8},(_,i)=>({id:String(i+3),brand:'kei',title:'Historical '+i,keywords:['multicore flexible']}))
];
test('matches words across brand, filename and aliases in any order',()=>{
 assert.deepEqual(matchingPricelists(items,'KEI solar August').map(x=>x.id),['1']);
 assert.deepEqual(matchingPricelists(items,'aug poly copper').map(x=>x.id),['2']);
 assert.deepEqual(matchingPricelists(items,'dc latest kei').map(x=>x.id),['1']);
});
test('searches entries beyond the first page and respects the brand filter',()=>{
 assert.equal(matchingPricelists(items,'flex').length,8);
 assert.equal(matchingPricelists(items,'copper','kei').length,0);
 assert.equal(matchingPricelists(items,'','polycab').length,1);
 assert.equal(matchingPricelists(items,'  ').length,10);
 assert.equal(matchingPricelists(items,'unknown').length,0);
});
