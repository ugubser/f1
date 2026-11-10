import {createInterface,emitKeypressEvents} from 'node:readline';
import {signIn,TokenStore,authFile} from './f1-auth.mjs';
const store=new TokenStore();
function passwordPrompt(){
  return new Promise((resolve,reject)=>{
    let value='';process.stdout.write('F1 account password (hidden): ');emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
    const finish=()=>{process.stdin.off('keypress',onKey);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
    const onKey=(text,key={})=>{
      if(key.ctrl&&key.name==='c'){finish();reject(new Error('Sign-in cancelled.'));}
      else if(key.name==='return'){finish();resolve(value);value='';}
      else if(key.name==='backspace')value=[...value].slice(0,-1).join('');
      else if(text&&!key.ctrl&&!key.meta)value+=text;
    };
    process.stdin.on('keypress',onKey);
  });
}
try{
  const command=process.argv[2];
  if(command==='status'){console.log(JSON.stringify(await store.status(),null,2));}
  else if(command==='logout'){await store.clear();console.log('Local F1 sign-in removed. Disconnect any open live view.');}
  else if(command==='login'){
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('For secure sign-in, run npm run f1:login in your own terminal. Credentials are not accepted as command arguments.');
    console.log('Your credentials are sent only to F1 over HTTPS. The password is never saved.');
    const rl=createInterface({input:process.stdin,output:process.stdout});
    const username=await new Promise(resolve=>rl.question('F1 account email: ',resolve));rl.close();
    let password=await passwordPrompt();
    try{const token=await signIn(username.trim(),password);await store.save(token);console.log('Signed in. Token expires '+new Date(token.expiresAt).toISOString()+'.');console.log('Token saved privately outside the project: '+authFile);console.log('Return to the app, choose Live F1 and click Connect.');}
    finally{password=null;}
  }else throw new Error('Use npm run f1:login, npm run f1:status or npm run f1:logout.');
}catch(error){console.error(error.message);process.exitCode=1;}
