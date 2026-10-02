// Following the pose of another picture (applyPoseGuide in server/workflows.js).
import { WORKFLOWS, applyPoseGuide, pickPoseLLLite, POSE_NODES } from '../server/workflows.js';
import { describe } from '../server/studio.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};
const byClass = (g, cls) => Object.entries(g).filter(([, n]) => n.class_type === cls);

const anima = Object.values(WORKFLOWS).find(d => d.pose);
check('a workflow declares a pose link', !!anima, 'none');
const graph = () => ({
  [anima.pose.model.node]: { class_type: 'Anything', inputs: { [anima.pose.model.input]: ['m', 0] } },
  m: { class_type: 'UNETLoader', inputs: {} },
});
const all = new Set([...POSE_NODES, 'DWPreprocessor']);
const patches = ['anima-lllite-inpainting-v2.safetensors', 'anima-lllite-pose-1.safetensors'];

check('the pose patch is picked, not the inpainting one', pickPoseLLLite(patches) === 'anima-lllite-pose-1.safetensors');
check('newest pose patch wins', pickPoseLLLite(['anima-lllite-pose-1.safetensors', 'anima-lllite-pose-2.safetensors']) === 'anima-lllite-pose-2.safetensors');
check('none when there is none', pickPoseLLLite(['anima-lllite-inpainting-v2.safetensors']) === '');

let g = graph();
let r = applyPoseGuide(g, anima, { image: 'pose.png', size: { width: 1024, height: 1536 }, available: all, patches });
const [[applyKey, apply]] = byClass(g, 'AnimaLLLiteApply');
const [[detectKey, detect]] = byClass(g, 'DWPreprocessor');
const [[scaleKey, scale], [fitKey, fit]] = byClass(g, 'ImageScale');
check('it applies', r.applied && r.patch === 'anima-lllite-pose-1.safetensors');
check('the sampler model now goes through the guide', g[anima.pose.model.node].inputs[anima.pose.model.input][0] === applyKey);
check('the guide wraps the model it was given', JSON.stringify(apply.inputs.model) === '["m",0]');
check('the guide sees the skeleton, at exactly the sampled size',
  apply.inputs.image[0] === fitKey && fit.inputs.image[0] === detectKey && fit.inputs.width === 1024 && fit.inputs.height === 1536);
check('the skeleton is drawn at the sampled short side, not 512', detect.inputs.resolution === 1024);
check('one figure is read from the whole picture, without the photo detector', detect.inputs.bbox_detector === 'None');
{
  const m = graph();
  applyPoseGuide(m, anima, { image: 'group.png', multi: true, available: all, patches });
  check('several people bring the detector back', byClass(m, 'DWPreprocessor')[0][1].inputs.bbox_detector === 'yolox_l.onnx');
}
check('the skeleton is taken at the sampled size, cropped', detect.inputs.image[0] === scaleKey
  && scale.inputs.width === 1024 && scale.inputs.height === 1536 && scale.inputs.crop === 'center');
check('it lets go before the last steps', apply.inputs.end_percent === 0.85 && apply.inputs.start_percent === 0);

g = graph();
r = applyPoseGuide(g, anima, { image: 'skeleton.png', detect: false, available: new Set(POSE_NODES), patches });
check('a picture that is already a skeleton skips detection',
  r.applied && byClass(g, 'DWPreprocessor').length === 0 && byClass(g, 'AnimaLLLiteApply')[0][1].inputs.image[0] === byClass(g, 'LoadImage')[0][0]);

g = graph();
r = applyPoseGuide(g, anima, { image: 'pose.png', strength: 5, end: 3, available: all, patches });
check('strength and end are held to their ranges', r.strength === 2 && r.end === 1);

g = graph();
r = applyPoseGuide(g, anima, { image: 'pose.png', strength: 0, available: all, patches });
check('strength 0 adds nothing', !r.applied && Object.keys(g).length === 2);

g = graph();
r = applyPoseGuide(g, anima, { image: 'pose.png', available: new Set(POSE_NODES), patches });
check('without DWPose it says so and adds nothing', !r.applied && r.missing.includes('DWPreprocessor') && Object.keys(g).length === 2);
r = applyPoseGuide(graph(), anima, { image: 'pose.png', available: all, patches: ['anima-lllite-inpainting-v2.safetensors'] });
check('without the patch it says so', !r.applied && r.missing.some(m => /pose/.test(m)));

const krea = Object.values(WORKFLOWS).find(d => !d.pose && d.kind !== 'video');
r = applyPoseGuide({}, krea, { image: 'pose.png', available: all, patches });
check('a workflow without a pose link refuses', !r.applied && r.reason === 'unsupported');

const objectInfo = { AnimaLLLiteApply: {}, DWPreprocessor: {}, ModelPatchLoader: { input: { required: { name: [patches] } } } };
check('the form offers pose where it works', describe(anima, { objectInfo }).has.pose === true);
check('and not where the patch is missing',
  !describe(anima, { objectInfo: { ...objectInfo, ModelPatchLoader: { input: { required: { name: [['x.safetensors']] } } } } }).has.pose);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
