import requests
import random
import time
from datetime import datetime, timedelta

# 配置
API_URL = "https://lost-track-game.com/api/track"
RESET_URL = "https://lost-track-game.com/api/admin/reset"
TOTAL_REQUESTS = 500  # 总共生成多少条数据
USER_POOL_SIZE = 50  # 模拟多少个不同的用户
DAYS_BACK = 30  # 生成过去多少天的数据

# 模拟数据池
PAGES = [
    "/home",
    "/products",
    "/products/detail/123",
    "/cart",
    "/checkout",
    "/login",
    "/profile",
    "/about",
]

EVENT_TYPES = ["view", "click", "hover", "input"]

TARGETS = [
    "screenshot-1",
    "screenshot-2",
    "screenshot-3",
    "screenshot-4",
    "screenshot-5",
    "screenshot-6",
    "title_social-twitter",
    "title_social-facebook",
    "title_social-instagram",
    "title_social-youtube",
    "title_background-top",
    "title_game-content",
    "title_about-us",
    "title_news",
]

COUNTRIES = [
    {"country": "CN", "region": "Beijing", "city": "Beijing"},
    {"country": "CN", "region": "Shanghai", "city": "Shanghai"},
    {"country": "US", "region": "California", "city": "Los Angeles"},
    {"country": "US", "region": "New York", "city": "New York"},
    {"country": "JP", "region": "Tokyo", "city": "Tokyo"},
    {"country": "JP", "region": "Osaka", "city": "Osaka"},
    {"country": "GB", "region": "England", "city": "London"},
    {"country": "DE", "region": "Berlin", "city": "Berlin"},
    {"country": "SG", "region": "Singapore", "city": "Singapore"},
    {"country": "AU", "region": "New South Wales", "city": "Sydney"},
]

# 生成虚拟用户池 (固定IP和位置，模拟真实用户多次访问)
users = []
for i in range(USER_POOL_SIZE):
    users.append(
        {
            "ip": f"192.168.{random.randint(1, 255)}.{random.randint(1, 255)}",
            "location": random.choice(COUNTRIES),
        }
    )


def generate_random_time():
    """生成过去 DAYS_BACK 天内的随机时间"""
    end = datetime.now()
    start = end - timedelta(days=DAYS_BACK)
    random_date = start + (end - start) * random.random()

    # 模拟白天的活跃度高于深夜 (简单的加权)
    hour = random_date.hour
    if 0 <= hour < 7:
        # 深夜，如果随机到这里，有50%概率重随，减少深夜数据量
        if random.random() > 0.5:
            return generate_random_time()

    return random_date


def reset_db():
    try:
        res = requests.delete(RESET_URL)
        if res.status_code == 200:
            print("✅ 数据库已清空")
        else:
            print("❌ 数据库重置失败")
    except Exception as e:
        print(f"❌ 连接错误: {e}")


def send_track_data():
    print(f"🚀 开始生成 {TOTAL_REQUESTS} 条模拟数据...")

    success_count = 0

    for i in range(TOTAL_REQUESTS):
        # 1. 随机选一个用户
        user = random.choice(users)

        # 2. 随机生成时间
        fake_time = generate_random_time()

        # 3. 随机生成行为
        page = random.choice(PAGES)
        event_type = random.choice(EVENT_TYPES)

        # 只有点击事件才有 target，浏览事件 target 为空
        target = random.choice(TARGETS) if event_type == "click" else ""

        # 随机停留时间 (毫秒)
        stay_time = random.randint(1000, 300000) if event_type == "view" else 0

        payload = {
            "type": event_type,
            "target": target,
            "page": page,
            "stayTime": stay_time,
            "timestamp": int(fake_time.timestamp() * 1000),
            # --- 欺骗后端的核心参数 ---
            "mock_ip": user["ip"],  # 模拟不同 IP
            "mock_location": user["location"],  # 模拟地理位置
            "custom_created_at": fake_time.isoformat(),  # 模拟历史时间
        }

        try:
            res = requests.post(API_URL, json=payload)
            if res.status_code == 200:
                success_count += 1
                # 打印进度条
                if i % 50 == 0:
                    print(
                        f"进度: {i}/{TOTAL_REQUESTS} ({fake_time.strftime('%Y-%m-%d %H:%M')})"
                    )
        except Exception as e:
            print(f"Request failed: {e}")

    print(f"🎉 完成! 成功插入 {success_count} 条数据")


if __name__ == "__main__":
    # 1. 先询问是否清空
    choice = input("是否在生成前清空数据库? (y/n): ")
    if choice.lower() == "y":
        reset_db()

    # 2. 发送数据
    send_track_data()
