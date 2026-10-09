import test from 'node:test';
import assert from 'node:assert/strict';
import {localPath} from '../desktop/localPath.mjs';
test('local links accept drive paths and encoded Korean file URLs',()=>{
 assert.equal(localPath('C:/Apps/Setup.exe'),'C:\\Apps\\Setup.exe');
 assert.equal(localPath('C:/My%20Apps/test.txt'),'C:\\My Apps\\test.txt');
 if(process.platform === 'win32') assert.equal(localPath('file:///C:/%ED%95%9C%EA%B8%80/a.txt'),'C:\\한글\\a.txt');
});
test('local links reject web URLs, relative paths, device paths and alternate streams',()=>{
 for(const value of ['https://example.com','javascript:alert(1)','../test','C:relative','C:/a:stream','\\\\server\\share','C:/x%00.exe']) assert.throws(()=>localPath(value));
});
