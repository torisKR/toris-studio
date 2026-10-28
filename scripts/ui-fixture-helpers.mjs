import { createServer } from 'vite';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { fileURLToPath } from 'node:url';
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const cargoTarget=path.resolve(projectRoot,process.env.CARGO_TARGET_DIR||'desktop/src-tauri/target');
export function nativeBinary(name,{example=false}={}){return path.join(cargoTarget,'debug',...(example?['examples']:[]),name+(process.platform==='win32'?'.exe':''));}
export const fixtureBridge={mcpExecutable:'/fixture/Toris Studio',protocolVersion:'2025-11-25',lastObservedAt:null};
export const unhandled=Symbol('unhandled fixture IPC');
/** Explicit read-only shell fixtures. Unexpected native mutations still fail. */
export function shellFixture(command,args={}){
 if(command==='oauth_connections')return {connections:[],bindings:[],warnings:[]};
 if(command==='analytics_dispatch'){
  if(args.input?.action==='status')return {schemaReady:false,migrationRequired:true,paused:false,jobs:[],capabilities:[],limits:{maxBytes:5242880,maxRows:10000,maxColumns:100}};
  if(args.input?.action==='query')return {observations:[],hasMore:false,coverage:[],totalIsNotComputed:true};
  if(args.input?.action==='importHistory')return {imports:[]};
 }
 if(command==='search_keywords')return {query:args.input?.query??'',mode:'local',items:[],total:0,libraryCount:0,indexLimit:500,truncated:false,searchedAt:new Date().toISOString(),warnings:[]};
 if(command==='get_keyword_status')return {databaseConnected:false,libraryCount:0,indexLimit:500,sources:[],engines:[],running:false};
 if(command==='get_keyword_runs')return [];
 if(command==='publication_list')return {publications:[],media:[],scheduler:{paused:false,running:false,message:'read-only shell fixture'}};
 if(command==='motion_request_list')return [];
 if(command==='asset_command'&&args.action==='snapshot')return {assets:[],jobs:[],total:0,libraryTotal:0,offset:0,limit:100,jobTotal:0,settings:{}};
 if(command==='creation_bridge_info')return structuredClone(fixtureBridge);
 if(command==='creation_request_list')return {requests:[]};
 if(command==='ai_status')return {providers:[],contentModel:null,agentModel:null,image:null};
 if(command==='set_main_activity'||command.startsWith('plugin:event|'))return 0;
 return unhandled;
}
export async function openSection(page,section,label){await page.getByRole('navigation',{name:'주 메뉴',exact:true}).getByRole('button',{name:section,exact:true}).click();if(label)await page.getByRole('navigation',{name:section+' 화면',exact:true}).getByRole('button',{name:label,exact:true}).click();}
export async function openCreation(page,label){await page.getByRole('navigation',{name:'주 메뉴',exact:true}).getByRole('button',{name:'제작',exact:true}).click();await page.getByRole('button',{name:label,exact:true}).click();}

export async function createFixtureServer(options={}){
 // Independent browser gates must not invalidate another gate's dependency cache.
 const cacheDir=await mkdtemp(path.join(tmpdir(),'toris-vite-fixture-'));
 try{const server=await createServer({...options,cacheDir,configFile:path.join(projectRoot,'desktop/vite.config.ts'),server:{host:'127.0.0.1',...(options.server||{}),hmr:false}});const close=server.close.bind(server);server.close=async()=>{try{await close();}finally{await rm(cacheDir,{recursive:true,force:true});}};return server;}
 catch(error){await rm(cacheDir,{recursive:true,force:true});throw error;}
}
