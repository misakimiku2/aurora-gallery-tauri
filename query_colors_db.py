#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
查询主色调数据库信息的脚本
"""
import sqlite3
import os
import json
from datetime import datetime

def query_colors_db(db_path):
    """查询数据库信息"""
    
    # 检查数据库文件是否存在
    if not os.path.exists(db_path):
        print(f"数据库文件不存在: {db_path}")
        return
    
    print(f"正在查询数据库: {db_path}")
    print("=" * 60)
    
    try:
        # 连接数据库
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # 1. 获取表结构
        print("\n数据库表结构:")
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = cursor.fetchall()
        for table in tables:
            print(f"  - {table[0]}")
            # 获取表的列信息
            cursor.execute(f"PRAGMA table_info({table[0]});")
            columns = cursor.fetchall()
            for col in columns:
                print(f"    * {col[1]} ({col[2]})")
        
        # 2. 获取总记录数
        cursor.execute("SELECT COUNT(*) FROM dominant_colors")
        total_count = cursor.fetchone()[0]
        print(f"\n总记录数: {total_count}")
        
        # 3. 按状态统计
        cursor.execute("SELECT status, COUNT(*) FROM dominant_colors GROUP BY status")
        status_counts = cursor.fetchall()
        print(f"\n按状态统计:")
        for status, count in status_counts:
            print(f"  - {status}: {count} 个文件")
        
        # 4. 获取数据库文件大小
        db_size = os.path.getsize(db_path)
        print(f"\n数据库文件大小: {db_size / 1024:.2f} KB")
        
        # 5. 获取一些示例数据
        print(f"\n最近处理的5个文件:")
        cursor.execute("""
            SELECT file_path, status, created_at, updated_at, colors
            FROM dominant_colors
            ORDER BY updated_at DESC
            LIMIT 5
        """)
        recent_files = cursor.fetchall()
        
        for file_path, status, created_at, updated_at, colors in recent_files:
            created_time = datetime.fromtimestamp(created_at).strftime('%Y-%m-%d %H:%M:%S')
            updated_time = datetime.fromtimestamp(updated_at).strftime('%Y-%m-%d %H:%M:%S')
            
            print(f"\n  文件: {file_path}")
            print(f"  状态: {status}")
            print(f"  创建时间: {created_time}")
            print(f"  更新时间: {updated_time}")
            
            if colors and colors != "[]":
                try:
                    color_data = json.loads(colors)
                    print(f"  颜色数量: {len(color_data)}")
                    if color_data:
                        print(f"  主色调: {color_data[0].get('hex', 'N/A')}")
                except:
                    print(f"  颜色数据: {colors[:50]}...")
            else:
                print(f"  颜色数据: 无")
        
        # 6. 统计颜色提取成功率
        cursor.execute("SELECT COUNT(*) FROM dominant_colors WHERE status = 'extracted'")
        extracted_count = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM dominant_colors WHERE status = 'pending'")
        pending_count = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM dominant_colors WHERE status = 'error'")
        error_count = cursor.fetchone()[0]
        
        print(f"\n处理状态统计:")
        print(f"  已提取: {extracted_count} ({extracted_count/total_count*100:.1f}%)")
        print(f"  待处理: {pending_count} ({pending_count/total_count*100:.1f}%)")
        print(f"  错误: {error_count} ({error_count/total_count*100:.1f}%)")
        
        conn.close()
        
    except sqlite3.Error as e:
        print(f"数据库错误: {e}")
    except Exception as e:
        print(f"未知错误: {e}")

if __name__ == "__main__":
    # 使用用户指定的数据库路径
    db_path = r"C:\Users\Misaki\AppData\Roaming\com.aurora.gallery\colors.db"
    query_colors_db(db_path)