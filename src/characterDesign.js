/**
 * A different character every time one is asked for.
 *
 * ## The two faults this is for
 *
 * Asked for "여캐 그려줘" with nothing else, a model writes `1girl, solo,
 * masterpiece` and stops -- it has been told nothing about how she looks, so it
 * says nothing. But a diffusion model handed no description does not draw "an
 * unspecified girl": it draws whatever its weights fall towards, which is the
 * same brown-haired girl in the same school uniform every single time. The
 * request was to design somebody, and nobody was designed.
 *
 * And asked twice, it answers twice the same. Not because it is stubborn --
 * because it is doing exactly what it was built to do. The prompt is the same,
 * the sampler is near-greedy, and the most likely continuation of "describe a
 * girl" is the most likely continuation of "describe a girl". Telling it to
 * "be creative" moves that distribution hardly at all; every request lands in
 * the same basin.
 *
 * ## So the variety comes from outside the model
 *
 * A pick from each axis below, made here, handed to the model as the starting
 * point for a turn. It is not a prompt and not a template -- it is the part of
 * the decision that a language model is worst at and a random number generator
 * is perfect at, and the model still does the writing.
 *
 * Which is also why the axes are the ones a person actually notices: hair,
 * eyes, clothes, palette, where she is, how she is framed. Two characters that
 * differ only in "mood: wistful" are the same character.
 *
 * Everything the request itself says wins over all of it. This fills silence;
 * it does not argue.
 */

/* Tags rather than sentences, because the anime model reads tags and the photo
   one reads either. These appearance candidates are kept in the vocabulary of
   assets/danbooru-tags.csv. An invented tag changes nothing, so it would make
   the variety look as though it were not working. */
export const DESIGN_AXES = {
  hair: [
    'black hair', 'blonde hair', 'brown hair', 'blue hair', 'white hair',
    'pink hair', 'grey hair', 'purple hair', 'red hair', 'green hair',
    'orange hair', 'aqua hair', 'multicolored hair', 'streaked hair',
    'two-tone hair', 'gradient hair', 'colored inner hair', 'split-color hair',
    'rainbow hair', 'fiery hair', 'glowing hair', 'crystal hair', 'starry hair',
  ],
  cut: [
    'long hair', 'short hair', 'medium hair', 'very long hair',
    'very short hair', 'absurdly long hair', 'bob cut', 'twintails',
    'low twintails', 'short twintails', 'ponytail', 'high ponytail',
    'low ponytail', 'short ponytail', 'side ponytail', 'front ponytail',
    'braid', 'single braid', 'twin braids', 'side braid', 'side braids',
    'long braid', 'crown braid', 'braided ponytail', 'braided bun',
    'half up braid', 'low twin braids', 'low-braided long hair',
    'hime cut', 'wavy hair', 'curly hair', 'straight hair', 'messy hair',
    'spiked hair', 'drill hair', 'undercut', 'blunt bangs', 'parted bangs',
    'swept bangs', 'curtained hair', 'crossed bangs', 'double-parted bangs',
    'asymmetrical bangs', 'long bangs', 'braided bangs', 'hair over one eye',
    'hair between eyes', 'hair over shoulder', 'hair down', 'hair slicked back',
    'hair pulled back', 'hair up', 'flipped hair', 'floating hair',
    'asymmetrical hair', 'short hair with long locks', 'low-tied long hair',
    'single hair bun', 'double bun', 'single side bun', 'cone hair bun',
    'multi-tied hair', 'tentacle hair', 'antenna hair', 'big hair',
    'feather hair', 'fluffy hair', 'pointy hair', 'wet hair',
  ],
  eyes: [
    'blue eyes', 'green eyes', 'brown eyes', 'purple eyes', 'red eyes',
    'yellow eyes', 'pink eyes', 'grey eyes', 'aqua eyes', 'orange eyes',
    'black eyes', 'multicolored eyes', 'glowing eyes', 'ringed eyes',
    'flower-shaped pupils', 'symbol in eye', 'third eye', 'empty eyes',
  ],
  outfit: [
    'school uniform', 'sailor dress', 'sailor shirt', 'winter uniform',
    'summer uniform', 'gym uniform', 'school swimsuit', 'streetwear',
    't-shirt', 'collared shirt', 'dress shirt', 'open shirt', 'sweater',
    'turtleneck sweater', 'ribbed sweater', 'hoodie', 'jacket', 'open jacket',
    'cropped jacket', 'track jacket', 'coat', 'open coat', 'lab coat',
    'raincoat', 'dress', 'sundress', 'long dress', 'short dress',
    'frilled dress', 'off-shoulder dress', 'pinafore dress', 'kimono',
    'china dress', 'white kimono', 'robe', 'suit', 'military uniform',
    'armor', 'bodysuit', 'overalls', 'apron', 'maid apron',
    'pleated skirt', 'miniskirt', 'long skirt', 'shorts', 'pants',
  ],
  palette: [
    'red dress', 'blue dress', 'pink dress', 'purple dress', 'green dress',
    'black dress', 'white dress', 'yellow dress', 'brown dress', 'grey dress',
    'red shirt', 'blue shirt', 'pink shirt', 'green shirt', 'yellow shirt',
    'black shirt', 'white shirt', 'red jacket', 'blue jacket', 'pink jacket',
    'green jacket', 'black jacket', 'white jacket', 'red skirt', 'blue skirt',
    'pink skirt', 'green skirt', 'black skirt', 'white skirt', 'purple skirt',
    'red kimono', 'blue kimono', 'pink kimono', 'black kimono',
    'multicolored jacket', 'two-tone dress', 'neon trim', 'rainbow gradient',
  ],
  accessory: [
    'glasses', 'sunglasses', 'round eyewear', 'eyepatch', 'headphones',
    'scarf', 'beret', 'witch hat', 'cowboy hat', 'sun hat', 'hat ribbon',
    'earrings', 'hoop earrings', 'single earring', 'stud earrings',
    'necklace', 'choker', 'red choker', 'white choker', 'ribbon',
    'hair ribbon', 'hair bow', 'hairpin', 'hair flower', 'flower earrings',
    'flower necklace', 'backpack', 'shoulder bag', 'handbag', 'school bag',
    'fingerless gloves', 'half gloves', 'black gloves', 'white gloves',
    'watch', 'wristwatch', 'eyewear on head',
  ],
  place: [
    'school', 'classroom', 'rooftop', 'library', 'cafe', 'street',
    'alley', 'city', 'cityscape', 'city lights', 'forest', 'bamboo forest',
    'garden', 'flower field', 'beach', 'bridge', 'shrine', 'train',
    'train interior', 'train station', 'rooftop', 'night sky', 'snow',
    'rain', 'sunset', 'night', 'neon lights',
  ],
  framing: [
    'upper body', 'cowboy shot', 'full body', 'portrait', 'from side',
    'from below', 'looking back', 'sitting', 'walking', 'leaning',
    'leaning forward', 'leaning back', 'leaning to the side',
    'leaning on object', 'dutch angle', 'from above',
  ],
  air: [
    'smile', 'light smile', 'nervous smile', 'false smile', 'evil smile',
    'serious', 'sleepy', 'happy', 'confused', 'blush', 'light blush',
    'full-face blush', 'nose blush', 'wide-eyed', 'eye contact',
  ],
};

export const AXES = Object.keys(DESIGN_AXES);

/**
 * The CSV-backed choices the LLM may select from.
 *
 * The application deliberately does not pick one value here. The LLM sees
 * every available value for each axis and chooses a coherent combination,
 * while the server later verifies the resulting prompt against the same CSV.
 */
export const designCue = (tags = []) => {
  if (Array.isArray(tags) && tags.length) {
    return `all Danbooru tags with more than 1,000 posts (choose from these):\n${tags.join(', ')}`;
  }
  return AXES.map(axis => `${axis}: ${DESIGN_AXES[axis].join(', ')}`).join('\n');
};

/* ------------------------------------------------------------ when to say it

   Only on a turn that asks for a picture. The system prompt is rebuilt every
   turn and a line that changes every turn costs the whole prefix cache, so this
   is not something to carry on turns about anything else. */

const DRAWS = /그려|그림|그려줘|일러스트|이미지|사진|캐릭터|여캐|남캐|draw|picture|image|illustration|portrait|render|art of/i;
/* An equation is drawn too, and it is drawn as a graph -- see src/chart.js. A
   design cue on that turn would be noise at best. */
const PLOTS = /그래프|차트|방정식|수식|함수|plot|graph|chart|equation|=/i;

/** Whether this turn is asking for a picture of somebody. */
export const asksForPicture = (text) => {
  const said = String(text || '');
  if (!DRAWS.test(said)) return false;
  return !PLOTS.test(said);
};
