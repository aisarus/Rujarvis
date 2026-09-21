import * as comfy from './jarvis/desktop/comfy';
const ГЕРОЙ =
  'masterpiece, best quality, anime style, 1boy, solo, one person, young man, ' +
  'full body, curly short dark brown hair, green eyes, thick eyebrows, ' +
  'white t-shirt, black gym shorts, white sneakers, ' +
  'clean lineart, flat cel shading, plain pale background';
const НЕ =
  'two heads, multiple heads, duplicate, multiple people, 2boys, green shorts, ' +
  'long hair, floating hair, lowres, bad anatomy, bad hands, extra limbs, ' +
  'extra legs, fused limbs, watermark, signature, text, colored lines, blurry, cropped';
const ФАЗЫ: Array<[string, string]> = [
  ['01-naskok', 'running hurdle step, body stretched tall leaning forward, both arms swung straight overhead, one knee driving up'],
  ['02-rondat-ruki-v-pol', 'entering a roundoff, torso bent sharply forward and down, both arms reaching to the floor ahead, back leg kicking up high behind'],
  ['03-rondat-stoyka', 'handstand, both hands planted on the floor, arms straight, body upside down, legs scissored apart overhead'],
  ['04-prihod-spinoy', 'snapping down out of a roundoff, landing on both feet facing backward, body upright, both arms swinging up overhead'],
  ['05-zamah', 'loading for a back handspring, deep squat sitting back on the heels, both arms swung far behind the body, chest up'],
  ['06-flyak-progib', 'airborne in a back handspring, body arched backward in a strong curve, both arms stretched overhead reaching back toward the floor'],
  ['07-flyak-ruki-kasayutsya', 'hands on the floor in a back handspring, both palms planted behind, arms straight, body inverted and arched, legs whipping over'],
  ['08-otryv', 'take-off for a back tuck, body stretched straight and vertical, both arms punching up overhead, feet just leaving the ground'],
  ['09-gruppirovka', 'tucked backflip at the peak, body curled into a tight ball in mid air, knees pulled to the chest, hands gripping the shins, upside down'],
  ['10-raskrytie', 'opening out of a back tuck, legs kicking down out of the tuck, body unfolding and straightening, arms out to the sides, still in the air'],
  ['11-prizemlenie', 'landing, deep absorbed landing, both feet planted, knees bent deeply, torso upright, both arms thrown forward at shoulder height'],
];
const ПАПКА = 'C:/Users/ariel/AppData/Local/Rujarvis/data/krita-live/связка3-аниме';
async function main() {
  for (const [имя, фаза] of ФАЗЫ) {
    const r = await comfy.drawPosed({
      prompt: `${ГЕРОЙ}, ${фаза}`, negative: НЕ, pose: `${имя}.png`,
      width: 512, height: 512, steps: 26, seed: 777001, strength: 1.25,
      saveTo: `${ПАПКА}/${имя}.png`,
    });
    console.log(имя, r.ok ? 'ок' : `ПЛОХО: ${r.error}`);
  }
}
void main();
