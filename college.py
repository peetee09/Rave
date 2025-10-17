
import mysql.connector as mysqlConnector
conn = mysqlConnector.connect(host='DESKTOP-HJ50UMS',user='root',passwd='root',database='sql')
if conn:print("Connection Successful :)")
else:print("Connection Failed :(")
cur = conn.cursor()
try:
    cur.execute("select * from college")
    print("Query Executed Successfully !!!")
    for row in cur:
        print(row)
except Exception as e:
    print("Invalid Query")
    print(e)
conn.close()
while True:
    print("this program was designed to calculate indivitual cass mark[test student Kent]" )
    name = input("Enter your student name: ")
    age = input("Enter student age: ")
    mark = input("Enter student rate[type read]: ")
    name = "Kent"
    age = "26"
    mark = "test 50 and task 30"
    score = "Read"
    print("school record" + name + "! They are" + age + "! and" + mark)
    print("_______________________________________________________________________________________")

    print("in order to get student cass mark add both test and task mark then divide by 2")
    num1 = input("enter a number: ")
    num2 = input("enter another number: ")
    results = float(num1) + float(num2)
    print(results/2)
    
    print("Enter student marks in the Calculator")
    print(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>")
    num1 = float(input("Enter first number: "))
    op = input("enter operator: ")
    num2 = float(input("Enter second number: "))
    
    num1 = input("enter task mark: ")
    num2 = input("enter test mark: ")
    
    num1 = input("Enter a number: ")
    num2 = input("Enter another number: ")
    results = float(num1) + float(num2)
    print(results/2)
    
    if op == "+" :
        print(num1 + num2)
    elif op == "-": 
        print(num1 - num2)
    elif op== "/":
        print(num1 / num2)
    elif op == "*":
        print(num1 * num2)
    else:
        print("invelid operator")