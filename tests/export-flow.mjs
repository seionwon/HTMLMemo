// Existing HTML round-trip scenarios now make an explicit choice in the new menu.
// Keep web-page capture clicks unchanged; never silently switch the product default.
import assert from 'node:assert/strict';
export async function chooseDocumentExport(page,mode='html'){
  const documentOpen=await page.evaluate('!!document.querySelector(".document-host:not([hidden]) iframe")');
  const incomplete=await page.evaluate('!!document.querySelector("[data-book-incomplete]")');
  await page.click('#save-page');if(!documentOpen||incomplete)return;
  await page.waitFor('!!document.querySelector("#dialog[open] [data-document-export]")');
  assert.equal(await page.evaluate('document.querySelector("[data-document-export] input:checked").value'),'archive');
  await page.click(`[data-document-export] input[value="${mode}"]`);
  await page.waitFor('!document.querySelector("[data-export-save]").disabled');
  await page.click('[data-export-save]');
}
