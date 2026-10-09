import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageOutputControls } from "../desktop/src/assets/ImageOutputControls";
import { defaultSpec } from "../desktop/src/assets/contracts";
import { applyPreset } from "../desktop/src/assets/presets";

test("shared controls expose every group, a custom choice and the selected preset ID",()=>{
  const markup=renderToStaticMarkup(createElement(ImageOutputControls,{spec:applyPreset(defaultSpec,"play-feature"),onChange:()=>{},showQuantity:false}));
  for(const group of ["Play 스토어","웹 아이콘","앱 캠페인","AdMob·전면 광고","기존 영상 규격"]) assert.ok(markup.includes(group));
  assert.match(markup,/value="play-feature" selected=""/);
  assert.match(markup,/알파 채널/);
  assert.match(markup,/배경색/);
  assert.doesNotMatch(markup,/요청 수량/);
});
test("favicon exposes ICO while the Play icon permits only PNG",()=>{
  const favicon=renderToStaticMarkup(createElement(ImageOutputControls,{spec:applyPreset(defaultSpec,"favicon-32"),onChange:()=>{}}));
  assert.match(favicon,/value="ico"/);
  const icon=renderToStaticMarkup(createElement(ImageOutputControls,{spec:applyPreset(defaultSpec,"play-icon"),onChange:()=>{}}));
  assert.doesNotMatch(icon,/value="ico"/);
  assert.doesNotMatch(icon,/value="webp"/);
  assert.match(icon,/1,024 KiB/);
});
