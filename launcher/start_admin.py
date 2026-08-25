#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""商城后台启动器"""
import sys
import start_shop

if __name__ == '__main__':
    sys.argv = [sys.argv[0], '--admin']
    start_shop.main()
