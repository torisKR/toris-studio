import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getQwen3TtsConfiguration,synthesizeWithQwen3Tts} from '../lib/tts/qwen3-local';

test('legacy Mac voice health and WAV response preserve MLX fallback and request contract',async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async(input,init)=>{
   if(String(input).endsWith('/health'))return Response.json({ok:true,speaker:'Sohee'});
   const body=JSON.parse(String(init?.body));
   assert.equal(body.text,'테스트');assert.equal(body.max_tokens,4096);
   assert.equal(body.top_p,0.95);assert.equal(body.top_k,50);
   return new Response(new Uint8Array([82,73,70,70]),{headers:{'x-duration-seconds':'1.25','x-sample-rate':'24000'}});
  };
  assert.equal((await getQwen3TtsConfiguration()).provider,'qwen3-tts-mlx');
  const result=await synthesizeWithQwen3Tts({text:'테스트'});
  assert.equal(result.provider,'qwen3-tts-mlx');assert.equal(result.durationSec,1.25);assert.equal(result.audio.length,4);
 }finally{globalThis.fetch=original;}
});
