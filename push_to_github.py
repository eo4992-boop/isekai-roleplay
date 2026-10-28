import subprocess
import os
import sys

DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(DIR)

def run(cmd):
    print(f"> {cmd}")
    res = subprocess.run(cmd, shell=True)
    return res.returncode == 0

print("=" * 60)
print(" [GitHub 자동 업로드]")
print("=" * 60)

repo = "isekai-roleplay"
print(f" 대상 저장소: https://github.com/eo4992-boop/{repo}.git")
print("-" * 60)

run('git -c "safe.directory=*" remote remove origin')
run(f'git -c "safe.directory=*" remote add origin https://github.com/eo4992-boop/{repo}.git')
run('git -c "safe.directory=*" branch -M main')

print("\nGitHub로 업로드(Push)를 시도합니다...")
print("(GitHub 인증 창이 뜨면 로그인해 주세요)\n")
success = run('git -c "safe.directory=*" push -u origin main')

print("\n" + "=" * 60)
if success:
    print(" [성공] GitHub에 코드가 성공적으로 업로드되었습니다!")
    print(f" 나만의 전용 웹 주소: https://eo4992-boop.github.io/{repo}/")
    print("\n [마지막 1단계]:")
    print(f" https://github.com/eo4992-boop/{repo}/settings/pages 접속 후")
    print(" Build and deployment -> Source를 'GitHub Actions'로 선택하면 끝!")
else:
    print(" [안내]")
    print(f" 1. https://github.com/new 에서 '{repo}' 이름의 저장소를 먼저 만들어주세요.")
    print(" 2. 만든 후 다시 이 프로그램을 실행하시면 정상 업로드됩니다.")
print("=" * 60)

input("\n엔터를 누르면 종료됩니다...")
