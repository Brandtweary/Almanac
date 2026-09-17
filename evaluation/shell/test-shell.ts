import assert from 'node:assert/strict';
import {shellCases,prepareShellCase} from './index.ts';
const commands={size:'ls -lS birch > result.txt',quote:"cp -- 'birch records/-draft note.txt' result.txt",numeric:'sort -n values.txt > result.txt',count:"grep -xc ready events.txt > result.txt"};
for(const test of shellCases){
 const session=await prepareShellCase(test);
 try{
  // A plausible claimed result without an execution never passes.
  assert.equal((await session.grade(test)).every(c=>c.passed),false);
  const result=await session.execute(commands[test.task].replaceAll('birch',test.split==='heldout'?'cedar':'birch'));
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal((await session.grade(test)).every(c=>c.passed),true,test.id);
  await session.execute('printf incorrect > result.txt');
  assert.equal((await session.grade(test)).find(c=>c.id==='exact_result')?.passed,false);
 }finally{session.dispose();}
}
const session=await prepareShellCase(shellCases[0]);
try{
 assert.equal((await session.execute('test ! -e /home && test ! -e /proc && test ! -e /etc && test ! -e /tmp && test -z "$OPENROUTER_API_KEY"')).exitCode,0);
 assert.notEqual((await session.execute('printf bad > /supervisor.py')).exitCode,0);
 assert.notEqual((await session.execute('printf bad > /dev/arbitrary')).exitCode,0);
 assert.equal((await session.execute('while :; do printf 123456789; done')).outputTruncated,true);
 assert.equal((await session.execute('while :; do printf 123456789 >&2; done')).outputTruncated,true);
 assert.equal((await session.execute('sleep 20 & printf spawned')).timedOut,true);
 assert.equal((await session.execute("PYTHONHOME=/ /bin/python3 -s -S -c \"import os; os.symlink('/supervisor.py', 'alias')\"")).exitCode,0);
 assert.equal('alias' in await session.inspect(),false);
 assert.equal((await session.execute('printf alive')).stdout,'alive');
 assert.notEqual((await session.execute('ls --invented-size-sort-flag')).exitCode,0);
 assert.equal((await session.execute('seq 1 100000 > oversized.txt')).exitCode,125);
 assert.equal('oversized.txt' in await session.inspect(),false);
}finally{session.dispose();}
console.log('Shell synthetic cases and containment checks passed');
