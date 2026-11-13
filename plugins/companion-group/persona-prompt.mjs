import { createGroupPersonaPort } from '../companion-foundation/group-persona.mjs';
import { resolveSuitePaths } from '../companion-foundation/suite-paths.mjs';

export function renderPublicPersona(snapshot) {
  if (!snapshot) return '【群聊公开人格不可用】不要编造角色设定。';
  const fields = [['身份', snapshot.identity], ['性格', snapshot.personality], ['说话习惯', snapshot.speakingStyle], ['兴趣', snapshot.interests?.join('；')], ['公开经历', snapshot.knownExperiences?.join('；')], ['互动边界', snapshot.interactionBoundaries?.join('；')]];
  return ['【群聊公开人格】', ...fields.filter(([, value]) => value).map(([label, value]) => label + '：' + value)].join(String.fromCharCode(10));
}

export function createPublicPersonaPrompt() {
  const port = createGroupPersonaPort({ suitePaths: resolveSuitePaths({ moduleUrl: import.meta.url }) });
  return () => renderPublicPersona(port.get());
}
