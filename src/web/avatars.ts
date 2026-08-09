export const AVATAR_NAMES = [
  "企鹅", "兔子", "凤头金丝雀", "刺猬", "北极兔", "北极熊", "北长尾山雀", "华美极乐鸟", "卡皮巴拉", "叶羊",
  "奶牛", "威廉多彩海蛞蝓", "宝石金龟", "小熊猫", "小鸭", "山魈", "斑马", "松鼠", "柯基", "柴犬",
  "树懒", "梅花鹿", "河马", "海獭", "海神海蛞蝓", "海豹", "海鞘", "海马", "熊", "熊猫",
  "狐狸", "狗", "狮子", "猪", "猫头鹰", "猴子", "章鱼", "红尾碧蝽卵", "红腹灰雀", "绵羊",
  "羊驼", "翼龙", "老虎", "考拉", "耳廓狐", "萤火虫", "萨摩耶", "蛋黄水母", "西班牙睡鼠", "豚鼠",
  "长颈鹿", "雪鸮", "霸王龙", "马来貘", "骆驼", "鲸鱼", "鸭子", "龙", "龙猫",
] as const;

const assetModules = import.meta.glob("./assets/avatars/watercolor-avatar-*.webp", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export interface AvatarOption {
  readonly id: number;
  readonly name: string;
  readonly src: string;
}

export const AVATARS: readonly AvatarOption[] = AVATAR_NAMES.map((name, index) => {
  const id = index + 1;
  const key = `./assets/avatars/watercolor-avatar-${id.toString().padStart(2, "0")}.webp`;
  const src = assetModules[key];
  if (!src) throw new Error(`头像素材缺失: ${id}`);
  return { id, name, src };
});

export function normalizeAvatarId(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= AVATARS.length ? Number(value) : 1;
}

export function avatarById(value: unknown): AvatarOption {
  return AVATARS[normalizeAvatarId(value) - 1]!;
}
